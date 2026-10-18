//! TextBundle folder documents (#157; typora-re images §3.1/§3.2,
//! fe-sidebar-statusbar-find §1/§5/§11): a `.textbundle` directory is opened,
//! saved and listed as one file; its `assets/` folder is the image target.
//!
//! Content file: `markdown.md` (spec v2) with `text.md` (v1) fallback — the
//! detail is not pinned down in the prose (typora-re#14).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// True when the path's own last component ends in `.textbundle`.
pub fn is_textbundle(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("textbundle"))
}

/// Some path component of `path` (not necessarily the last) is a bundle folder.
pub fn inside_textbundle(path: &Path) -> bool {
    path.components()
        .rev()
        .skip(1) // the file itself, e.g. `markdown.md`
        .any(|c| is_textbundle(c.as_os_str().as_ref()))
}

/// The bundle's markdown file: `markdown.md` (v2) if present, else `text.md` (v1).
pub fn content_file(bundle: &Path) -> PathBuf {
    let v2 = bundle.join("markdown.md");
    if v2.is_file() {
        v2
    } else {
        bundle.join("text.md")
    }
}

/// Minimal `text.json` for bundles Margin creates (TextBundle spec v2).
pub const TEXT_JSON: &str = "{\"version\":2,\"type\":\"net.daringfireball.markdown\"}\n";

/// Ensure the bundle skeleton exists (dir, `assets/`, `text.json`); returns the
/// content file to write into (existing file kept, `markdown.md` for new bundles).
pub fn ensure_bundle(bundle: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(bundle)?;
    let assets = bundle.join("assets");
    if !assets.exists() {
        match fs::create_dir(&assets) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    let meta = bundle.join("text.json");
    if !meta.exists() {
        fs::write(&meta, TEXT_JSON)?;
    }
    let v1 = bundle.join("text.md");
    Ok(if v1.is_file() && !bundle.join("markdown.md").is_file() { v1 } else { bundle.join("markdown.md") })
}

pub fn read_bundle(bundle: &Path) -> io::Result<String> {
    let f = content_file(bundle);
    if !f.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{}: not a TextBundle (no markdown.md/text.md)", bundle.display()),
        ));
    }
    fsops::read_text(&f)
}

use crate::fsops;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_bundle_names_case_insensitively() {
        assert!(is_textbundle(Path::new("/n/Journal.textbundle")));
        assert!(is_textbundle(Path::new("/n/Journal.TEXTBUNDLE")));
        assert!(!is_textbundle(Path::new("/n/Journal.textbundle.md")));
        assert!(!is_textbundle(Path::new("/n/journal.md")));
        assert!(inside_textbundle(Path::new("/n/j.textbundle/assets/a.png")));
        assert!(!inside_textbundle(Path::new("/n/j.textbundle")));
        assert!(!inside_textbundle(Path::new("/n/assets/a.png")));
    }

    #[test]
    fn ensure_creates_skeleton_and_prefers_v2() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("note.textbundle");
        let content = ensure_bundle(&bundle).unwrap();
        assert_eq!(content, bundle.join("markdown.md")); // v2 default for a new bundle
        fs::write(&content, "# v2\n").unwrap();
        assert!(bundle.join("assets").is_dir());
        let meta: serde_json::Value = serde_json::from_str(&fs::read_to_string(bundle.join("text.json")).unwrap()).unwrap();
        assert_eq!(meta["version"], 2);
        assert_eq!(meta["type"], "net.daringfireball.markdown");
        // Re-ensure keeps an existing v1 file and never rewrites text.json.
        fs::remove_file(&content).unwrap();
        fs::write(bundle.join("text.md"), "# v1\n").unwrap();
        fs::write(bundle.join("text.json"), "{\"version\":1,\"type\":\"x\"}").unwrap();
        assert_eq!(ensure_bundle(&bundle).unwrap(), bundle.join("text.md"));
        assert!(fs::read_to_string(bundle.join("text.json")).unwrap().starts_with("{\"version\":1"));
    }

    #[test]
    fn reads_content_with_v1_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("a.textbundle");
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("text.md"), "# v1\n").unwrap();
        assert_eq!(read_bundle(&bundle).unwrap(), "# v1\n");
        fs::write(bundle.join("markdown.md"), "# v2\n").unwrap();
        assert_eq!(read_bundle(&bundle).unwrap(), "# v2\n");
    }
}
