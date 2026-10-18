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
    sniff(data).unwrap_or("png")
}

/// Extension from magic bytes, if recognisable.
pub fn sniff(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG") {
        Some("png")
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if data.starts_with(b"GIF8") {
        Some("gif")
    } else if data.len() > 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("webp")
    } else if data.starts_with(b"BM") {
        Some("bmp")
    } else if data.len() > 12 && &data[4..8] == b"ftyp" && (&data[8..12] == b"avif" || &data[8..12] == b"avis") {
        Some("avif")
    } else if data.starts_with(b"II*\0") || data.starts_with(b"MM\0*") {
        Some("tiff")
    } else {
        let head = String::from_utf8_lossy(&data[..data.len().min(512)]).to_ascii_lowercase();
        (head.contains("<svg")).then_some("svg")
    }
}

/// `image-yyyyMMddHHmmssSSS.ext` (Typora's pasted-image name), unique inside `dir`:
/// on a collision the name gets `-1`, `-2`, … appended.
pub fn unique_generated_name(dir: &Path, ext: &str) -> PathBuf {
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S%3f");
    let base = format!("image-{stamp}");
    let first = dir.join(format!("{base}.{ext}"));
    if !first.exists() {
        return first;
    }
    (1u32..).map(|i| dir.join(format!("{base}-{i}.{ext}"))).find(|p| !p.exists()).expect("unbounded")
}

/// Typora's duplicate-name suffix: the last 7 digits of the Unix time in seconds.
pub fn duplicate_suffix(now_secs: u64) -> String {
    let s = now_secs.to_string();
    s[s.len().saturating_sub(7)..].to_string()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Candidate names when copying `name` into a folder: `name`, then Typora's
/// `stem-<7 digits of unix seconds>.ext`, then `stem-<digits>-1.ext`, `-2`, …
pub fn duplicate_candidates(name: &str, secs: u64) -> impl Iterator<Item = String> {
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let ts = duplicate_suffix(secs);
    let first = name.to_string();
    std::iter::once(first).chain((0u32..).map(move |i| if i == 0 { format!("{stem}-{ts}{ext}") } else { format!("{stem}-{ts}-{i}{ext}") }))
}

/// Copy `src` into `dir` as `name` — on a name clash as `stem-<ts7>.ext` (Typora's
/// rule) — reusing a same-named file that already holds identical bytes (Margin:
/// re-inserting the same image never duplicates it), and never overwriting another
/// file (create-new, so concurrent pastes of same-named images can't clobber each other).
pub fn copy_unique(src: &Path, dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    let meta = fs::metadata(src)?;
    if meta.is_dir() {
        return Err(std::io::Error::other(format!("{} is a directory", src.display())));
    }
    if let Some(existing) = identical_sibling(src, dir, name, meta.len()) {
        return Ok(existing);
    }
    for cand_name in duplicate_candidates(name, now_secs()) {
        let cand = dir.join(&cand_name);
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

/// A file in `dir` named `name` or `stem-….ext` (an earlier duplicate) with the same bytes as `src`.
fn identical_sibling(src: &Path, dir: &Path, name: &str, len: u64) -> Option<PathBuf> {
    let exact = dir.join(name);
    if exact.is_file() && same_contents(&exact, src) {
        return Some(exact);
    }
    let path = Path::new(name);
    let stem = format!("{}-", path.file_stem()?.to_string_lossy());
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut hits: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with(&stem) && n.ends_with(&ext) && n.len() > stem.len() + ext.len()
        })
        .filter(|e| e.metadata().map(|m| m.is_file() && m.len() == len).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| same_contents(p, src))
        .collect();
    hits.sort();
    hits.into_iter().next()
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
    // A TextBundle document resolves relative rules from (and writes srcs against)
    // the bundle root, so `assets/` lands inside it (#157).
    let doc_dir = doc_path
        .map(|p| if crate::textbundle::is_textbundle(p) { normalize(p) } else { p.parent().map(normalize).unwrap_or_default() })
        .filter(|d| !d.as_os_str().is_empty());
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

/// After an unsaved document got its first path: copy the images that were parked in
/// `fallback_dir` (srcs returned while unsaved: absolute, percent-encoded) under the
/// document's rule. Returns `(old_src, new_src)` for every src that moved; other srcs
/// (remote, relative, outside the fallback dir, missing) are left alone.
pub fn relocate_fallback(
    doc_path: &Path,
    rule: &ImageRule,
    srcs: &[String],
    fallback_dir: &Path,
    home: Option<&Path>,
) -> Vec<(String, String, PathBuf)> {
    if matches!(rule, ImageRule::None) {
        return vec![];
    }
    let fb = normalize(fallback_dir);
    let mut out = Vec::new();
    for src in srcs {
        let decoded = percent_encoding::percent_decode_str(src).decode_utf8_lossy().into_owned();
        let p = normalize(Path::new(&decoded));
        if !p.is_absolute() || !p.starts_with(&fb) || !p.is_file() {
            continue;
        }
        if let Ok(st) = store_image(Some(doc_path), rule, ImageInput::File(&p), fallback_dir, home)
            && st.src != *src
        {
            out.push((src.clone(), st.src, st.abs));
        }
    }
    out
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

    /// `<stem>-<7 digits>(-N)?<ext>`: Typora's duplicate-name rule.
    fn is_dup(src: &str, stem: &str, ext: &str) -> bool {
        let Some(mid) = src.strip_prefix(stem).and_then(|r| r.strip_suffix(ext)).and_then(|r| r.strip_prefix('-')) else { return false };
        let ts = mid.split('-').next().unwrap_or("");
        ts.len() == 7 && ts.chars().all(|c| c.is_ascii_digit())
    }

    #[test]
    fn duplicate_suffix_is_last_seven_digits_of_unix_seconds() {
        assert_eq!(duplicate_suffix(1_760_000_123), "0000123");
        assert_eq!(duplicate_suffix(42), "42");
        let c: Vec<String> = duplicate_candidates("a b.png", 1_760_123_456).take(3).collect();
        assert_eq!(c, ["a b.png", "a b-0123456.png", "a b-0123456-1.png"]);
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
        // image-yyyyMMddHHmmssSSS.png (Typora's pasted-image name), `-N` on a same-ms clash
        let core = name.trim_end_matches(".png");
        assert!(core.len() >= "image-20260101120000123".len(), "{name}");
        assert!(core["image-".len().."image-20260101120000123".len()].chars().all(|c| c.is_ascii_digit()), "{name}");
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
        assert!(is_dup(&r3.src, "assets/shot", ".png"), "{}", r3.src);
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
