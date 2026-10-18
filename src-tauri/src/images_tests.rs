//! store_image edge cases: collisions, odd names, traversal attempts, concurrency.

use crate::images::*;
use std::fs;
use std::path::{Path, PathBuf};

fn rel(dir: &str) -> ImageRule {
    ImageRule::Relative { dir: dir.into() }
}

fn decode(src: &str) -> String {
    percent_encoding::percent_decode_str(src).decode_utf8().unwrap().into_owned()
}

#[test]
fn filename_template_with_spaces_unicode_and_dots() {
    let dir = tempfile::tempdir().unwrap();
    for (doc, want) in [
        ("我的 笔记.md", "我的%20笔记.assets/"),
        ("v1.2 notes.md", "v1.2%20notes.assets/"),
        ("100% (draft) #1.md", "100%25%20%28draft%29%20%231.assets/"),
    ] {
        let d = dir.path().join(doc);
        let r = store_image(Some(&d), &rel("./${filename}.assets"), ImageInput::Bytes { data: b"GIF89a", mime: None, name: None }, dir.path(), None).unwrap();
        assert!(r.src.starts_with(want), "{doc}: {}", r.src);
        // decoding the src and resolving it against the doc dir gives the stored file
        assert_eq!(dir.path().join(decode(&r.src)), r.abs);
    }
}

#[test]
fn src_round_trips_for_hostile_file_names() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let src_dir = dir.path().join("in");
    fs::create_dir(&src_dir).unwrap();
    let mut names = vec!["a b.png", "50%.png", "x(1).png", "q?.png", "h#.png", "<t>.png", "tab\t.png", "[br].png", "ünï.png"];
    if cfg!(unix) {
        names.extend(["back\\slash.png", "new\nline.png"]);
    }
    for n in names {
        let img = src_dir.join(n);
        fs::write(&img, n.as_bytes()).unwrap();
        let r = store_image(Some(&doc), &rel("assets"), ImageInput::File(&img), dir.path(), None).unwrap();
        assert!(!r.src.contains(' ') && !r.src.contains('\n') && !r.src.contains('\t'), "{n:?} → {}", r.src);
        assert!(!r.src.contains('\\'), "{n:?}: backslash must not survive (it escapes in CommonMark) → {}", r.src);
        assert_eq!(dir.path().join(decode(&r.src)), r.abs, "{n:?} → {}", r.src);
        assert_eq!(fs::read(&r.abs).unwrap(), n.as_bytes());
    }
}

#[test]
fn bytes_name_cannot_traverse() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("sub/doc.md");
    fs::create_dir_all(doc.parent().unwrap()).unwrap();
    for name in ["../../evil.png", "/etc/passwd.png", "..\\..\\x.png", "a/../../b.svg"] {
        let r = store_image(Some(&doc), &rel("assets"), ImageInput::Bytes { data: b"\x89PNG", mime: None, name: Some(name) }, dir.path(), None).unwrap();
        assert!(r.abs.starts_with(dir.path().join("sub/assets")), "{name}: {}", r.abs.display());
        assert!(r.src.starts_with("assets/image-"), "{name}: {}", r.src);
    }
}

#[test]
fn rule_with_dotdot_and_absolute_tilde() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let doc = dir.path().join("a/b/doc.md");
    fs::create_dir_all(doc.parent().unwrap()).unwrap();
    let r = store_image(Some(&doc), &rel("../../img/./x/.."), ImageInput::Bytes { data: b"GIF8", mime: None, name: None }, dir.path(), None).unwrap();
    assert!(r.src.starts_with("../../img/image-"), "{}", r.src);
    assert!(r.abs.starts_with(dir.path().join("img")));
    let abs = ImageRule::Absolute { dir: "~/Pictures/${filename}".into() };
    let r = store_image(Some(&doc), &abs, ImageInput::Bytes { data: b"GIF8", mime: None, name: None }, dir.path(), Some(&home)).unwrap();
    assert!(r.abs.starts_with(home.join("Pictures/doc")), "{}", r.abs.display());
    assert!(Path::new(&decode(&r.src)).is_absolute());
}

#[test]
fn collisions_suffix_and_dedupe_by_content() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let a = dir.path().join("x/shot.png");
    let b = dir.path().join("y/shot.png");
    let c = dir.path().join("z/shot.png");
    for (p, d) in [(&a, "A"), (&b, "B"), (&c, "A")] {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, d).unwrap();
    }
    let s = |p: &PathBuf| store_image(Some(&doc), &rel("assets"), ImageInput::File(p), dir.path(), None).unwrap().src;
    assert_eq!(s(&a), "assets/shot.png");
    assert_eq!(s(&b), "assets/shot-1.png");
    assert_eq!(s(&c), "assets/shot.png", "same bytes reuse the existing copy");
    assert_eq!(s(&b), "assets/shot-1.png", "…also for the suffixed copy");
    // no extension / dot file
    let n = dir.path().join("x/README");
    fs::write(&n, "r").unwrap();
    assert_eq!(s(&n), "assets/README");
}

#[test]
fn concurrent_copies_of_same_named_files_never_clobber() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    let srcs: Vec<PathBuf> = (0..16)
        .map(|i| {
            let p = dir.path().join(format!("src{i}/image.png"));
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, format!("content {i}").repeat(4096)).unwrap();
            p
        })
        .collect();
    let results: Vec<Stored> = std::thread::scope(|s| {
        let hs: Vec<_> = srcs
            .iter()
            .map(|p| s.spawn(|| store_image(Some(&doc), &rel("assets"), ImageInput::File(p), dir.path(), None).unwrap()))
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    for (src, r) in srcs.iter().zip(&results) {
        assert_eq!(fs::read(&r.abs).unwrap(), fs::read(src).unwrap(), "{} was overwritten", r.src);
    }
    let mut uniq: Vec<_> = results.iter().map(|r| r.src.clone()).collect();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), 16);
}

#[test]
fn missing_or_directory_source_is_an_error_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("doc.md");
    assert!(store_image(Some(&doc), &rel("assets"), ImageInput::File(&dir.path().join("nope.png")), dir.path(), None).is_err());
    let d = dir.path().join("folder.png");
    fs::create_dir(&d).unwrap();
    assert!(store_image(Some(&doc), &rel("assets"), ImageInput::File(&d), dir.path(), None).is_err());
    let left: Vec<_> = fs::read_dir(dir.path().join("assets")).map(|r| r.count()).into_iter().collect();
    assert!(left.is_empty() || left == vec![0], "partial copies left behind: {left:?}");
}

#[test]
fn ext_sniffing_and_mime_precedence() {
    assert_eq!(ext_for(Some("IMAGE/PNG"), Some("x.jpg"), b""), "png");
    assert_eq!(ext_for(Some("application/octet-stream"), Some("x.JPEG"), b""), "jpg");
    assert_eq!(ext_for(None, Some("x.exe"), b"RIFF\0\0\0\0WEBPVP8 "), "webp");
    assert_eq!(ext_for(None, None, b"<?xml ?><svg xmlns"), "svg");
    assert_eq!(ext_for(None, None, b"????"), "png", "unknown bytes default to png");
}

#[test]
fn relocate_parked_images_on_first_save() {
    let dir = tempfile::tempdir().unwrap();
    let fb = dir.path().join("app data/images");
    let a = store_image(None, &rel("./assets"), ImageInput::Bytes { data: b"\x89PNG a", mime: None, name: None }, &fb, None).unwrap();
    let b = store_image(None, &rel("./assets"), ImageInput::Bytes { data: b"GIF89a", mime: None, name: None }, &fb, None).unwrap();
    assert!(a.src.contains("app%20data"), "{}", a.src);
    let doc = dir.path().join("notes/My Doc.md");
    fs::create_dir_all(doc.parent().unwrap()).unwrap();
    let srcs = vec![a.src.clone(), b.src.clone(), "https://x/y.png".into(), "assets/z.png".into(), "/nonexistent/p.png".into()];
    let moved = relocate_fallback(&doc, &rel("./${filename}.assets"), &srcs, &fb, None);
    assert_eq!(moved.len(), 2);
    for (old, new, abs) in &moved {
        assert!(new.starts_with("My%20Doc.assets/image-"), "{old} → {new}");
        assert_eq!(doc.parent().unwrap().join(decode(new)), *abs);
    }
    assert!(relocate_fallback(&doc, &ImageRule::None, &srcs, &fb, None).is_empty());
}
