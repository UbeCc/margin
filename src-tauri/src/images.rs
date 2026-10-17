//! `store_image`: copy (never move) or write image data into the directory chosen by
//! the user's `ImageRule`, and return the markdown `src` to insert.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Mirrors `ImageRule` in `src/contracts.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ImageRule {
    Relative { dir: String },
    Absolute { dir: String },
    None,
}

impl Default for ImageRule {
    fn default() -> Self {
        ImageRule::Relative { dir: "./assets".into() }
    }
}

pub enum ImageInput<'a> {
    File(&'a Path),
    Bytes { data: &'a [u8], mime: Option<&'a str>, name: Option<&'a str> },
}

#[derive(Debug)]
pub struct Stored {
    /// Markdown src (forward slashes, URL-escaped).
    pub src: String,
    /// Absolute path of the file on disk (for asset scope).
    pub abs: PathBuf,
}

/// Expand `${filename}` (document file name without extension) and a leading `~`.
pub fn expand_dir(template: &str, doc_path: Option<&Path>, home: Option<&Path>) -> String {
    let stem = doc_path
        .and_then(|p| p.file_stem())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled".into());
    let mut s = template.replace("${filename}", &stem);
    if let Some(h) = home
        && (s == "~" || s.starts_with("~/")) {
            s = format!("{}{}", h.to_string_lossy(), &s[1..]);
        }
    s
}

/// Lexically normalize `a/./b/../c` → `a/c` (no filesystem access).
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Relative path from directory `base` to `target` (both absolute, normalized).
pub fn relative_path(base: &Path, target: &Path) -> Option<PathBuf> {
    let b: Vec<_> = base.components().collect();
    let t: Vec<_> = target.components().collect();
    // different roots / drive letters → no relative path
    if b.first() != t.first() {
        return None;
    }
    let common = b.iter().zip(&t).take_while(|(x, y)| x == y).count();
    let mut out = PathBuf::new();
    for _ in common..b.len() {
        out.push("..");
    }
    for c in &t[common..] {
        out.push(c.as_os_str());
    }
    Some(out)
}

/// Turn a filesystem path into a markdown link target: forward slashes, and the
/// characters that break `![](...)` or URL parsing are percent-encoded
/// (space, %, (, ), <, >, #, ?). Non-ASCII stays readable.
pub fn to_markdown_src(p: &Path) -> String {
    // Windows separators become `/`; on Unix a backslash is a legal name character.
    let s = if cfg!(windows) { p.to_string_lossy().replace('\\', "/") } else { p.to_string_lossy().into_owned() };
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '%' => out.push_str("%25"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            // a backslash escapes punctuation in CommonMark link destinations
            '\\' => out.push_str("%5C"),
            c if c.is_control() => {
                let mut b = [0u8; 4];
                for byte in c.encode_utf8(&mut b).bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
            c => out.push(c),
        }
    }
    out
}

pub fn ext_for(mime: Option<&str>, name: Option<&str>, data: &[u8]) -> &'static str {
    if let Some(m) = mime {
        match m.to_ascii_lowercase().as_str() {
            "image/png" => return "png",
            "image/jpeg" | "image/jpg" => return "jpg",
            "image/gif" => return "gif",
            "image/webp" => return "webp",
            "image/svg+xml" => return "svg",
            "image/bmp" => return "bmp",
            "image/tiff" => return "tiff",
            "image/avif" => return "avif",
            "image/x-icon" | "image/vnd.microsoft.icon" => return "ico",
            _ => {}
        }
    }
    if let Some(ext) = name.and_then(|n| Path::new(n).extension()).map(|e| e.to_string_lossy().to_ascii_lowercase()) {
        for known in ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "avif", "ico"] {
            if ext == known {
                return if known == "jpeg" { "jpg" } else { known };
            }
        }
    }
    // sniff magic bytes
    if data.starts_with(b"\x89PNG") {
        "png"
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if data.starts_with(b"GIF8") {
        "gif"
    } else if data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "webp"
    } else if data.starts_with(b"BM") {
        "bmp"
    } else {
        "png"
    }
}

fn random_suffix() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..3).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

/// `image-YYYYMMDD-HHMMSS-xxx.ext`, unique inside `dir`.
pub fn unique_generated_name(dir: &Path, ext: &str) -> PathBuf {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    loop {
        let p = dir.join(format!("image-{stamp}-{}.{ext}", random_suffix()));
        if !p.exists() {
            return p;
        }
    }
}

/// Copy `src` into `dir` as `name`, `stem-1.ext`, `stem-2.ext`, … — reusing any of
/// those that already holds identical bytes, and never overwriting another file
/// (create-new, so concurrent pastes of same-named images can't clobber each other).
fn copy_unique(src: &Path, dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    let meta = fs::metadata(src)?;
    if meta.is_dir() {
        return Err(std::io::Error::other(format!("{} is a directory", src.display())));
    }
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 0u32.. {
        let cand = if i == 0 { dir.join(name) } else { dir.join(format!("{stem}-{i}{ext}")) };
        if cand.exists() {
            if same_contents(&cand, src) {
                return Ok(cand);
            }
            continue;
        }
        let mut out = match fs::OpenOptions::new().write(true).create_new(true).open(&cand) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let res = fs::File::open(src).and_then(|mut i| std::io::copy(&mut i, &mut out)).and_then(|_| out.sync_all());
        if let Err(e) = res {
            let _ = fs::remove_file(&cand);
            return Err(e);
        }
        let _ = fs::set_permissions(&cand, meta.permissions());
        return Ok(cand);
    }
    unreachable!()
}

fn same_contents(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(ma), Ok(mb)) if ma.len() == mb.len() => fs::read(a).ok() == fs::read(b).ok(),
        _ => false,
    }
}

/// Core of the `store_image` command.
///
/// * `rule = none`: a file input is referenced where it is; bytes go to `fallback_dir`.
/// * unsaved document (`doc_path = None`) with a relative rule: written to `fallback_dir`
///   and referenced by absolute path (the frontend may relocate on first save).
/// * `relative`: src is relative to the document directory.
/// * `absolute`: src is the absolute path.
pub fn store_image(
    doc_path: Option<&Path>,
    rule: &ImageRule,
    input: ImageInput,
    fallback_dir: &Path,
    home: Option<&Path>,
) -> std::io::Result<Stored> {
    let doc_dir = doc_path.and_then(|p| p.parent()).map(normalize);
    let (target_dir, relative_to): (PathBuf, Option<PathBuf>) = match (rule, &doc_dir) {
        (ImageRule::None, _) => {
            if let ImageInput::File(p) = input {
                let abs = normalize(p);
                let src = match &doc_dir {
                    Some(d) => relative_path(d, &abs).unwrap_or_else(|| abs.clone()),
                    None => abs.clone(),
                };
                return Ok(Stored { src: to_markdown_src(&src), abs });
            }
            (fallback_dir.to_path_buf(), None)
        }
        (ImageRule::Relative { dir }, Some(d)) => {
            let expanded = expand_dir(dir, doc_path, home);
            let p = Path::new(&expanded);
            let target = if p.is_absolute() { normalize(p) } else { normalize(&d.join(p)) };
            (target, Some(d.clone()))
        }
        (ImageRule::Relative { .. }, None) => (fallback_dir.to_path_buf(), None),
        (ImageRule::Absolute { dir }, _) => {
            let expanded = expand_dir(dir, doc_path, home);
            let p = PathBuf::from(&expanded);
            let target = if p.is_absolute() {
                normalize(&p)
            } else if let Some(d) = &doc_dir {
                normalize(&d.join(p))
            } else {
                fallback_dir.to_path_buf()
            };
            (target, None)
        }
    };
    fs::create_dir_all(&target_dir)?;

    let dest = match input {
        ImageInput::File(src) => {
            let src = normalize(src);
            // Already inside the target dir → reference it, don't duplicate.
            if src.parent() == Some(target_dir.as_path()) && src.exists() {
                src
            } else {
                let name = src
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "image.png".into());
                copy_unique(&src, &target_dir, &name)?
            }
        }
        ImageInput::Bytes { data, mime, name } => {
            let ext = ext_for(mime, name, data);
            let dest = unique_generated_name(&target_dir, ext);
            // create_new semantics: never clobber.
            let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&dest)?;
            std::io::Write::write_all(&mut f, data)?;
            dest
        }
    };

    let src_path = match &relative_to {
        Some(base) => relative_path(base, &dest).unwrap_or_else(|| dest.clone()),
        None => dest.clone(),
    };
    Ok(Stored { src: to_markdown_src(&src_path), abs: dest })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_filename_and_home() {
        let doc = Path::new("/notes/My Doc.md");
        assert_eq!(expand_dir("./${filename}.assets", Some(doc), None), "./My Doc.assets");
        assert_eq!(expand_dir("~/pics", None, Some(Path::new("/Users/me"))), "/Users/me/pics");
        assert_eq!(expand_dir("${filename}", None, None), "untitled");
    }

    #[test]
    fn relative_paths() {
        assert_eq!(relative_path(Path::new("/a/b"), Path::new("/a/b/c/d.png")).unwrap(), PathBuf::from("c/d.png"));
        assert_eq!(relative_path(Path::new("/a/b"), Path::new("/a/x/d.png")).unwrap(), PathBuf::from("../x/d.png"));
        assert_eq!(normalize(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
    }

    #[test]
    fn markdown_src_encoding() {
        assert_eq!(to_markdown_src(Path::new("My Doc.assets/a (1).png")), "My%20Doc.assets/a%20%281%29.png");
        assert_eq!(to_markdown_src(Path::new("图片/x.png")), "图片/x.png");
    }

    #[test]
    fn stores_bytes_with_generated_name() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("My Doc.md");
        fs::write(&doc, "").unwrap();
        let rule = ImageRule::Relative { dir: "./${filename}.assets".into() };
        let png = b"\x89PNG\r\n\x1a\nrest";
        let a = store_image(Some(&doc), &rule, ImageInput::Bytes { data: png, mime: None, name: None }, dir.path(), None).unwrap();
        let b = store_image(Some(&doc), &rule, ImageInput::Bytes { data: png, mime: Some("image/png"), name: None }, dir.path(), None).unwrap();
        assert!(a.src.starts_with("My%20Doc.assets/image-"), "{}", a.src);
        assert!(a.src.ends_with(".png"));
        assert_ne!(a.src, b.src);
        let name = a.abs.file_name().unwrap().to_string_lossy().into_owned();
        // image-YYYYMMDD-HHMMSS-xxx.png
        assert_eq!(name.len(), "image-20260101-120000-abc.png".len(), "{name}");
        assert_eq!(fs::read(&a.abs).unwrap(), png);
    }

    #[test]
    fn copies_file_never_moves_and_dedupes() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let src_dir = dir.path().join("elsewhere");
        fs::create_dir(&src_dir).unwrap();
        let img = src_dir.join("shot.png");
        fs::write(&img, b"one").unwrap();
        let rule = ImageRule::Relative { dir: "assets".into() };
        let r1 = store_image(Some(&doc), &rule, ImageInput::File(&img), dir.path(), None).unwrap();
        assert_eq!(r1.src, "assets/shot.png");
        assert!(img.exists(), "source must remain (copy, not move)");
        // same content again → reuse
        let r2 = store_image(Some(&doc), &rule, ImageInput::File(&img), dir.path(), None).unwrap();
        assert_eq!(r2.src, "assets/shot.png");
        // different content, same name → suffix
        fs::write(&img, b"two").unwrap();
        let r3 = store_image(Some(&doc), &rule, ImageInput::File(&img), dir.path(), None).unwrap();
        assert_eq!(r3.src, "assets/shot-1.png");
        // parent-relative rule
        let up = ImageRule::Relative { dir: "../shared img".into() };
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let r4 = store_image(Some(&sub.join("d.md")), &up, ImageInput::File(&img), dir.path(), None).unwrap();
        assert_eq!(r4.src, "../shared%20img/shot.png");
    }

    #[test]
    fn none_rule_and_unsaved_doc() {
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("pic.png");
        fs::write(&img, b"x").unwrap();
        let doc = dir.path().join("doc.md");
        let r = store_image(Some(&doc), &ImageRule::None, ImageInput::File(&img), dir.path(), None).unwrap();
        assert_eq!(r.src, "pic.png");
        let fallback = dir.path().join("fallback");
        let r = store_image(None, &ImageRule::default(), ImageInput::Bytes { data: b"GIF89a", mime: None, name: None }, &fallback, None).unwrap();
        assert!(r.abs.starts_with(&fallback));
        assert!(r.src.ends_with(".gif"));
        assert!(Path::new(&r.src.replace("%20", " ")).is_absolute());
    }

    #[test]
    fn absolute_rule() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("abs");
        let rule = ImageRule::Absolute { dir: target.to_string_lossy().into_owned() };
        let r = store_image(Some(&dir.path().join("d.md")), &rule, ImageInput::Bytes { data: b"\xFF\xD8\xFFx", mime: None, name: None }, dir.path(), None).unwrap();
        assert!(r.abs.starts_with(&target));
        assert!(r.src.ends_with(".jpg"));
    }

    #[test]
    fn rule_serde_matches_ts() {
        let r: ImageRule = serde_json::from_str(r#"{"kind":"relative","dir":"./assets"}"#).unwrap();
        assert_eq!(r, ImageRule::Relative { dir: "./assets".into() });
        let n: ImageRule = serde_json::from_str(r#"{"kind":"none"}"#).unwrap();
        assert_eq!(n, ImageRule::None);
    }
}
