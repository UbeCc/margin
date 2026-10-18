use super::*;

fn png_with_dpi(ppm: u32) -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
    // IHDR (13 bytes, contents irrelevant here)
    v.extend_from_slice(&13u32.to_be_bytes());
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&[0; 13]);
    v.extend_from_slice(&[0; 4]);
    v.extend_from_slice(&9u32.to_be_bytes());
    v.extend_from_slice(b"pHYs");
    v.extend_from_slice(&ppm.to_be_bytes());
    v.extend_from_slice(&ppm.to_be_bytes());
    v.push(1);
    v.extend_from_slice(&[0; 4]);
    v
}

#[test]
fn scale_from_png_phys_and_jfif() {
    assert_eq!(image_scale_of(&png_with_dpi(5669)), 2.0); // 144 dpi Retina screenshot
    assert_eq!(image_scale_of(&png_with_dpi(2835)), 1.0); // 72 dpi
    assert_eq!(image_scale_of(b"\x89PNG\r\n\x1a\n"), 1.0);
    let jfif = [0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 1, 1, 0, 216, 0, 216, 0, 0];
    assert_eq!(image_scale_of(&jfif), 3.0);
    assert_eq!(image_scale_of(b"GIF89a"), 1.0);
}

#[test]
fn copies_with_duplicate_rule_and_moves() {
    let t = tempfile::tempdir().unwrap();
    let a = t.path().join("src/a.png");
    fs::create_dir_all(a.parent().unwrap()).unwrap();
    fs::write(&a, "A").unwrap();
    let out = t.path().join("out");
    let d1 = copy_image_to(&a, &out, None, false).unwrap();
    assert_eq!(d1, out.join("a.png"));
    assert!(a.exists());
    // same bytes → reused; different bytes, same name → stem-<ts7>.png
    assert_eq!(copy_image_to(&a, &out, None, false).unwrap(), d1);
    fs::write(&a, "B").unwrap();
    let d2 = copy_image_to(&a, &out, None, true).unwrap();
    let n = d2.file_name().unwrap().to_string_lossy().into_owned();
    assert!(n.starts_with("a-") && n.ends_with(".png") && n.len() == "a-1234567.png".len(), "{n}");
    assert!(!a.exists(), "move removes the original");
    assert_eq!(fs::read_to_string(&d1).unwrap(), "A");
    // already inside the folder → unchanged
    assert_eq!(copy_image_to(&d1, &out, None, true).unwrap(), d1);
    assert!(d1.exists());
}

#[test]
fn explicit_names_never_clobber_and_reject_traversal() {
    let t = tempfile::tempdir().unwrap();
    let a = t.path().join("a.png");
    fs::write(&a, "A").unwrap();
    fs::write(t.path().join("b.png"), "B").unwrap();
    assert!(copy_image_to(&a, t.path(), Some("b.png"), true).unwrap_err().contains("already exists"));
    assert!(copy_image_to(&a, t.path(), Some("../x.png"), false).is_err());
    let r = copy_image_to(&a, t.path(), Some("c.png"), true).unwrap();
    assert_eq!(fs::read_to_string(r).unwrap(), "A");
    assert!(!a.exists());
    // target is a file
    let f = t.path().join("b.png");
    assert!(copy_image_to(&t.path().join("c.png"), &f, None, false).unwrap_err().contains("not a directory"));
    assert!(copy_image_to(&t.path().join("missing.png"), t.path(), None, false).is_err());
}
