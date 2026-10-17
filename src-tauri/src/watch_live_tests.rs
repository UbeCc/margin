//! Live watcher tests: real OS events (FSEvents / inotify) for the save patterns of
//! common editors. Each test watches a fresh temp dir and asserts on the batches the
//! frontend would receive.

use crate::fsops::{self, OwnWrites};
use crate::watch::{FsEvent, start};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

struct Harness {
    rx: Receiver<Vec<FsEvent>>,
    own: Arc<OwnWrites>,
    _w: crate::watch::Watch,
}

fn harness(root: &Path) -> Harness {
    let (tx, rx) = channel();
    let own = Arc::new(OwnWrites::default());
    let w = start(root, own.clone(), move |b| {
        let _ = tx.send(b);
    })
    .unwrap();
    // FSEvents needs a moment before it reports changes made after the stream starts.
    std::thread::sleep(Duration::from_millis(350));
    Harness { rx, own, _w: w }
}

impl Harness {
    /// Collect events until `quiet` passes without a batch (or `max` elapses).
    fn collect(&self, quiet: Duration, max: Duration) -> Vec<FsEvent> {
        let start = Instant::now();
        let mut out = Vec::new();
        let mut last = Instant::now();
        while start.elapsed() < max {
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(b) => {
                    out.extend(b);
                    last = Instant::now();
                }
                Err(_) if !out.is_empty() && last.elapsed() > quiet => break,
                Err(_) => {}
            }
        }
        out
    }
    fn settle(&self) -> Vec<FsEvent> {
        self.collect(Duration::from_millis(600), Duration::from_secs(4))
    }
}

fn s(p: &Path) -> String {
    fsops::path_str(p)
}

fn tmpdir() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().to_path_buf();
    (d, p)
}

/// Another editor's atomic save of `path`: write a sibling temp file, rename it over.
fn external_atomic_save(path: &Path, text: &str, tmp_name: &str) {
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, text).unwrap();
    fs::rename(&tmp, path).unwrap();
}

fn mods_of(evs: &[FsEvent], p: &str) -> usize {
    evs.iter().filter(|e| matches!(e, FsEvent::Modified { path } if path == p)).count()
}

#[test]
fn file_watch_survives_repeated_atomic_saves() {
    let (_d, dir) = tmpdir();
    let f = dir.join("doc.md");
    fs::write(&f, "v0").unwrap();
    let h = harness(&f);
    for i in 1..=3 {
        external_atomic_save(&f, &format!("v{i}"), ".doc.md.tmp-xyz");
        let evs = h.settle();
        assert!(mods_of(&evs, &s(&f)) >= 1, "save {i}: {evs:?}");
        assert!(
            !evs.iter().any(|e| matches!(e, FsEvent::Removed { .. } | FsEvent::Renamed { .. })),
            "save {i}: {evs:?}"
        );
    }
}

#[test]
fn file_watch_own_save_is_silent_then_external_change_seen() {
    let (_d, dir) = tmpdir();
    let f = dir.join("doc.md");
    fs::write(&f, "v0").unwrap();
    let h = harness(&f);
    h.own.record(&f, true);
    fsops::atomic_write(&f, b"mine").unwrap();
    h.own.record(&f, true);
    let evs = h.collect(Duration::from_millis(600), Duration::from_millis(1500));
    assert!(evs.is_empty(), "own save should be silent: {evs:?}");
    std::thread::sleep(Duration::from_millis(400)); // leave the own-write window
    fs::write(&f, "external in-place").unwrap();
    let evs = h.settle();
    assert!(mods_of(&evs, &s(&f)) >= 1, "external write after own save: {evs:?}");
}

/// vim (backupcopy=auto): `doc.md` → `doc.md~`, write new `doc.md`, delete `doc.md~`;
/// before that it probes writability with a file named `4913`.
fn vim_save(f: &Path, text: &str) {
    let probe = f.with_file_name("4913");
    fs::write(&probe, "").unwrap();
    fs::remove_file(&probe).unwrap();
    let backup = f.with_file_name(format!("{}~", f.file_name().unwrap().to_string_lossy()));
    fs::rename(f, &backup).unwrap();
    fs::write(f, text).unwrap();
    fs::remove_file(&backup).unwrap();
}

fn assert_only_modified(evs: &[FsEvent], f: &Path) {
    assert!(mods_of(evs, &s(f)) >= 1, "{evs:?}");
    let other: Vec<_> = evs.iter().filter(|e| !matches!(e, FsEvent::Modified { path } if *path == s(f))).collect();
    assert!(other.is_empty(), "unexpected events {other:?} in {evs:?}");
}

#[test]
fn vim_save_in_watched_folder_is_a_modify() {
    let (_d, dir) = tmpdir();
    let f = dir.join("doc.md");
    fs::write(&f, "v0").unwrap();
    let h = harness(&dir);
    vim_save(&f, "v1");
    assert_only_modified(&h.settle(), &f);
}

#[test]
fn vim_save_of_watched_file_is_a_modify() {
    let (_d, dir) = tmpdir();
    let f = dir.join("doc.md");
    fs::write(&f, "v0").unwrap();
    let h = harness(&f);
    vim_save(&f, "v1");
    assert_only_modified(&h.settle(), &f);
    vim_save(&f, "v2");
    assert_only_modified(&h.settle(), &f);
}

/// JetBrains "safe write": `x___jb_tmp___` then `x` → `x___jb_old___`, tmp → `x`, delete old.
#[test]
fn jetbrains_safe_write_is_a_modify() {
    let (_d, dir) = tmpdir();
    let f = dir.join("doc.md");
    fs::write(&f, "v0").unwrap();
    let h = harness(&dir);
    let tmp = dir.join("doc.md___jb_tmp___");
    let old = dir.join("doc.md___jb_old___");
    fs::write(&tmp, "v1").unwrap();
    fs::rename(&f, &old).unwrap();
    fs::rename(&tmp, &f).unwrap();
    fs::remove_file(&old).unwrap();
    assert_only_modified(&h.settle(), &f);
}

#[test]
fn burst_of_creates_reports_each_file_once() {
    let (_d, dir) = tmpdir();
    let h = harness(&dir);
    let n = 300;
    for i in 0..n {
        fs::write(dir.join(format!("n{i:03}.md")), "x").unwrap();
    }
    let evs = h.collect(Duration::from_millis(800), Duration::from_secs(8));
    for i in 0..n {
        let p = s(&dir.join(format!("n{i:03}.md")));
        let c = evs.iter().filter(|e| matches!(e, FsEvent::Created { path } | FsEvent::Modified { path } if *path == p)).count();
        assert!(c >= 1, "missing {p}");
        assert!(c <= 2, "{p} reported {c} times");
    }
}

#[test]
fn rename_and_delete_in_folder() {
    let (_d, dir) = tmpdir();
    let a = dir.join("a.md");
    let gone = dir.join("gone.md");
    fs::write(&a, "x").unwrap();
    fs::write(&gone, "x").unwrap();
    let h = harness(&dir);
    fs::rename(&a, dir.join("b.md")).unwrap();
    fs::remove_file(&gone).unwrap();
    let evs = h.settle();
    let renamed = evs.iter().any(|e| matches!(e, FsEvent::Renamed { from, to } if *from == s(&a) && *to == s(&dir.join("b.md"))));
    let split = evs.contains(&FsEvent::Removed { path: s(&a) }) && evs.contains(&FsEvent::Created { path: s(&dir.join("b.md")) });
    assert!(renamed || split, "{evs:?}");
    assert!(evs.contains(&FsEvent::Removed { path: s(&gone) }), "{evs:?}");
}

#[test]
fn create_then_delete_within_one_batch_is_silent() {
    let (_d, dir) = tmpdir();
    let h = harness(&dir);
    let p = dir.join("flash.md");
    fs::write(&p, "x").unwrap();
    fs::remove_file(&p).unwrap();
    let evs = h.collect(Duration::from_millis(600), Duration::from_millis(1500));
    assert!(evs.is_empty(), "{evs:?}");
}

#[test]
fn directory_rename_and_its_children() {
    let (_d, dir) = tmpdir();
    fs::create_dir_all(dir.join("old/sub")).unwrap();
    fs::write(dir.join("old/sub/x.md"), "x").unwrap();
    let h = harness(&dir);
    fs::rename(dir.join("old"), dir.join("new")).unwrap();
    let evs = h.settle();
    assert!(
        evs.contains(&FsEvent::Renamed { from: s(&dir.join("old")), to: s(&dir.join("new")) }),
        "{evs:?}"
    );
    // children were re-keyed: editing one is a modify, not a create
    std::thread::sleep(Duration::from_millis(50));
    fs::write(dir.join("new/sub/x.md"), "changed!").unwrap();
    let evs = h.settle();
    assert_eq!(evs, vec![FsEvent::Modified { path: s(&dir.join("new/sub/x.md")) }]);
}

#[test]
fn moved_in_and_moved_out() {
    let (_d, base) = tmpdir();
    let dir = base.join("w");
    let outside = base.join("outside");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("in.md"), "x").unwrap();
    fs::write(dir.join("out.md"), "x").unwrap();
    let h = harness(&dir);
    fs::rename(outside.join("in.md"), dir.join("in.md")).unwrap();
    fs::rename(dir.join("out.md"), outside.join("out.md")).unwrap();
    let evs = h.settle();
    assert!(evs.contains(&FsEvent::Created { path: s(&dir.join("in.md")) }), "{evs:?}");
    assert!(evs.contains(&FsEvent::Removed { path: s(&dir.join("out.md")) }), "{evs:?}");
    assert_eq!(evs.len(), 2, "{evs:?}");
}

#[test]
fn own_saves_in_watched_folder() {
    let (_d, dir) = tmpdir();
    let existing = dir.join("e.md");
    fs::write(&existing, "x").unwrap();
    let h = harness(&dir);
    let fresh = dir.join("Save As.md");
    for (p, existed) in [(&existing, true), (&fresh, false)] {
        h.own.record(p, existed);
        fsops::atomic_write(p, b"mine").unwrap();
        h.own.record(p, existed);
    }
    let evs = h.collect(Duration::from_millis(600), Duration::from_secs(3));
    assert_eq!(evs, vec![FsEvent::Created { path: s(&fresh) }]);
}

#[test]
fn delete_and_recreate_is_a_modify() {
    let (_d, dir) = tmpdir();
    let f = dir.join("doc.md");
    fs::write(&f, "v0").unwrap();
    let h = harness(&dir);
    fs::remove_file(&f).unwrap();
    fs::write(&f, "v1 longer").unwrap();
    assert_only_modified(&h.settle(), &f);
}

#[test]
fn hidden_and_vcs_noise_is_ignored() {
    let (_d, dir) = tmpdir();
    let h = harness(&dir);
    fs::create_dir_all(dir.join(".git/objects")).unwrap();
    fs::write(dir.join(".git/objects/ab"), "x").unwrap();
    fs::write(dir.join(".DS_Store"), "x").unwrap();
    fs::write(dir.join(".doc.md.swp"), "x").unwrap();
    let evs = h.collect(Duration::from_millis(600), Duration::from_millis(1500));
    assert!(evs.is_empty(), "{evs:?}");
}

#[cfg(unix)]
#[test]
fn symlinked_file_reports_the_link_path() {
    let (_d, dir) = tmpdir();
    let real = dir.join("real.md");
    let link = dir.join("link.md");
    fs::write(&real, "v0").unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let h = harness(&link);
    fs::write(&real, "v1 changed").unwrap();
    assert_only_modified(&h.settle(), &link);
}

#[test]
fn file_watch_reports_delete_and_rename_away() {
    let (_d, dir) = tmpdir();
    let f = dir.join("doc.md");
    fs::write(&f, "v0").unwrap();
    let h = harness(&f);
    fs::rename(&f, dir.join("renamed.md")).unwrap();
    let evs = h.settle();
    assert_eq!(evs, vec![FsEvent::Renamed { from: s(&f), to: s(&dir.join("renamed.md")) }], "{evs:?}");
    fs::rename(dir.join("renamed.md"), &f).unwrap();
    let _ = h.settle();
    fs::remove_file(&f).unwrap();
    assert_eq!(h.settle(), vec![FsEvent::Removed { path: s(&f) }]);
}
