//! Edge cases for `atomic_write` / `read_text` (unix-heavy; each test documents the
//! behaviour a desktop editor must have).

use crate::fsops::*;
use std::fs;
use std::path::Path;

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

    fn is_root() -> bool {
        fs::metadata("/proc/self").map(|m| m.uid() == 0).unwrap_or(false)
            || std::env::var("USER").map(|u| u == "root").unwrap_or(false)
    }

    #[test]
    fn read_only_file_is_not_silently_overwritten() {
        if is_root() {
            return; // root bypasses permission bits
        }
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ro.md");
        fs::write(&p, "keep").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o444)).unwrap();
        let e = atomic_write(&p, b"clobber").unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied, "{e}");
        assert_eq!(fs::read_to_string(&p).unwrap(), "keep");
        assert_eq!(names(dir.path()), vec!["ro.md"]);
    }

    #[test]
    fn writable_file_in_read_only_dir_is_saved_in_place() {
        if is_root() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("locked");
        fs::create_dir(&sub).unwrap();
        let p = sub.join("doc.md");
        fs::write(&p, "old content that is longer").unwrap();
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o555)).unwrap();
        let r = atomic_write(&p, b"new");
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(r.unwrap(), "existed");
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        assert_eq!(names(&sub), vec!["doc.md"]);
    }

    #[test]
    fn new_file_in_read_only_dir_fails_cleanly() {
        if is_root() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("locked");
        fs::create_dir(&sub).unwrap();
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o555)).unwrap();
        let r = atomic_write(&sub.join("new.md"), b"x");
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(r.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        assert!(names(&sub).is_empty());
    }

    #[test]
    fn dangling_symlink_creates_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("link.md");
        symlink("real.md", &link).unwrap(); // relative, target missing
        assert!(!atomic_write(&link, b"hello").unwrap());
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(dir.path().join("real.md")).unwrap(), "hello");
    }

    #[test]
    fn symlink_chain_and_relative_link_into_subdir() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        let real = dir.path().join("notes/real.md");
        fs::write(&real, "old").unwrap();
        symlink("notes/real.md", dir.path().join("l1.md")).unwrap();
        symlink("l1.md", dir.path().join("l2.md")).unwrap();
        atomic_write(&dir.path().join("l2.md"), b"new").unwrap();
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
        assert!(fs::symlink_metadata(dir.path().join("l1.md")).unwrap().file_type().is_symlink());
        assert!(fs::symlink_metadata(dir.path().join("l2.md")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn hard_links_stay_linked() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        fs::write(&a, "old").unwrap();
        fs::hard_link(&a, &b).unwrap();
        atomic_write(&a, b"new").unwrap();
        assert_eq!(fs::read_to_string(&b).unwrap(), "new", "the other hard link must see the save");
        assert_eq!(fs::metadata(&a).unwrap().ino(), fs::metadata(&b).unwrap().ino());
    }

    #[test]
    fn setuid_like_mode_bits_and_odd_modes_survive() {
        let dir = tempfile::tempdir().unwrap();
        for mode in [0o600, 0o640, 0o664, 0o700, 0o755] {
            let p = dir.path().join(format!("m{mode:o}.md"));
            fs::write(&p, "x").unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
            atomic_write(&p, b"y").unwrap();
            assert_eq!(fs::metadata(&p).unwrap().mode() & 0o7777, mode, "{mode:o}");
        }
    }

    #[test]
    fn extended_attributes_survive_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("tagged.md");
        fs::write(&p, "x").unwrap();
        if !crate::fsops::xattr_set(&p, "user.margin.test", b"blue") {
            eprintln!("xattrs unsupported here; skipping");
            return;
        }
        atomic_write(&p, b"y").unwrap();
        assert_eq!(crate::fsops::xattr_get(&p, "user.margin.test").as_deref(), Some(&b"blue"[..]));
    }

    #[test]
    fn foreign_owned_file_keeps_its_owner() {
        if !is_root() {
            return; // needs chown; exercised in the Linux container (root)
        }
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("shared.md");
        fs::write(&p, "x").unwrap();
        std::os::unix::fs::chown(&p, Some(65534), Some(65534)).unwrap();
        atomic_write(&p, b"y").unwrap();
        let m = fs::metadata(&p).unwrap();
        assert_eq!((m.uid(), m.gid()), (65534, 65534));
        assert_eq!(fs::read_to_string(&p).unwrap(), "y");
    }
}

#[test]
fn concurrent_writers_never_tear_or_leak_temps() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("race.md");
    let payloads: Vec<String> = (0..8).map(|i| format!("{i}").repeat(64 * 1024 + i)).collect();
    std::thread::scope(|s| {
        for t in &payloads {
            let p = p.clone();
            s.spawn(move || {
                for _ in 0..10 {
                    atomic_write(&p, t.as_bytes()).unwrap();
                }
            });
        }
    });
    let got = fs::read_to_string(&p).unwrap();
    assert!(payloads.contains(&got), "torn write ({} bytes)", got.len());
    assert_eq!(names(dir.path()), vec!["race.md"]);
}

#[test]
fn readers_never_see_partial_content() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("r.md");
    let a = "a".repeat(300_000);
    let b = "b".repeat(200_000);
    atomic_write(&p, a.as_bytes()).unwrap();
    let stop = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|s| {
        s.spawn(|| {
            for i in 0..40 {
                atomic_write(&p, if i % 2 == 0 { b.as_bytes() } else { a.as_bytes() }).unwrap();
            }
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            let t = read_text(&p).unwrap();
            assert!(t == a || t == b, "partial read of {} bytes", t.len());
        }
    });
}

#[test]
fn decode_edge_cases() {
    // UTF-16 BE with BOM, odd trailing byte, empty file, lone BOM
    assert_eq!(decode_text(&[0xFE, 0xFF, 0, b'h', 0, b'i']), "hi");
    assert_eq!(decode_text(&[0xFF, 0xFE, b'h', 0, b'i']), "h");
    assert_eq!(decode_text(b""), "");
    assert_eq!(decode_text(b"\xEF\xBB\xBF"), "");
    // CRLF and NUL bytes are preserved verbatim
    assert_eq!(decode_text(b"a\r\nb\0c"), "a\r\nb\0c");
}

#[test]
fn natural_cmp_properties() {
    use std::cmp::Ordering::*;
    assert_eq!(natural_cmp("a01", "a1"), Equal);
    assert_eq!(natural_cmp("x99999999999999999999999", "x100000000000000000000000"), Less);
    assert_eq!(natural_cmp("", "a"), Less);
    assert_eq!(natural_cmp("ä", "z"), Greater); // byte order for non-ASCII; stable, no panic
    // antisymmetry over a small cross product
    let xs = ["a", "a1", "a01", "a2", "a10", "b", "1", "01", "10", "", "a1b2", "a1b10"];
    for x in xs {
        for y in xs {
            assert_eq!(natural_cmp(x, y), natural_cmp(y, x).reverse(), "{x} vs {y}");
        }
    }
}
