//! TextBundle folder documents (#157; typora-re images §3.1/§3.2,
//! fe-sidebar-statusbar-find §1/§5/§11): a `.textbundle` directory is opened,
//! saved and listed as one file; its `assets/` folder is the image target.
//!
//! Content file (typora-re images §3.4, Typora's shared front end): the first
//! regular `text.<supported extension>` file — `text.md` wins when several
//! exist — and `info.json` is neither validated nor required. New bundles get
//! `text.md` + `assets/` + a v2 `info.json`. Margin extension (not parity):
//! Typora 1.5.12 on macOS never enables TextBundle, and the shared front end
//! never reads spec-v2 `markdown.md`; Margin keeps `markdown.md` only as a
//! last-resort fallback so v2 bundles from other apps still open (#157).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Extensions accepted for the `text.*` content file (SupportedTextFiles, images §3.4).
pub const CONTENT_EXTS: &[&str] = &[
    "md", "markdown", "mmd", "mkd", "mdwn", "mdown", "mdx", "mdtxt", "mdtext", "apib", "rmarkdown", "rmd", "qmd", "txt", "text",
];

/// True when the path's own last component ends in `.textbundle`.
pub fn is_textbundle(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("textbundle"))
}

/// Some path component of `path` (not necessarily the last) is a bundle folder.
pub fn inside_textbundle(path: &Path) -> bool {
    path.components()
        .rev()
        .skip(1) // the file itself, e.g. `text.md`
        .any(|c| is_textbundle(c.as_os_str().as_ref()))
}

fn is_content_name(name: &str) -> bool {
    name.strip_prefix("text.").is_some_and(|ext| CONTENT_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)))
}

/// The bundle's existing content file, if any: `text.md`, else the first (by name)
/// `text.<supported ext>` regular file, else Margin's `markdown.md` fallback.
pub fn existing_content_file(bundle: &Path) -> Option<PathBuf> {
    let v1 = bundle.join("text.md");
    if v1.is_file() {
        return Some(v1);
    }
    let mut names: Vec<String> = fs::read_dir(bundle)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_content_name(n))
        .collect();
    names.sort();
    if let Some(n) = names.first() {
        return Some(bundle.join(n));
    }
    let v2 = bundle.join("markdown.md");
    v2.is_file().then_some(v2)
}

/// The content file to read/write: the existing one, or `text.md` for a new bundle.
pub fn content_file(bundle: &Path) -> PathBuf {
    existing_content_file(bundle).unwrap_or_else(|| bundle.join("text.md"))
}

/// `info.json` for bundles Margin creates: Typora's v2 metadata shape, Margin's identifier.
pub const INFO_JSON: &str =
    "{\"version\":2,\"type\":\"net.daringfireball.markdown\",\"transient\":false,\"creatorIdentifier\":\"dev.ubec.margin\"}\n";

/// Ensure the bundle skeleton exists (dir, `assets/`, `info.json`); returns the
/// content file to write into (existing file kept, `text.md` for new bundles).
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
    let meta = bundle.join("info.json");
    if !meta.exists() && existing_content_file(bundle).is_none() {
        fs::write(&meta, INFO_JSON)?;
    }
    Ok(content_file(bundle))
}

pub fn read_bundle(bundle: &Path) -> io::Result<String> {
    let Some(f) = existing_content_file(bundle) else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{}: not a TextBundle (no text.* content file)", bundle.display()),
        ));
    };
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
    fn ensure_creates_typora_skeleton() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("note.textbundle");
        let content = ensure_bundle(&bundle).unwrap();
        assert_eq!(content, bundle.join("text.md")); // Typora writes text.md for new bundles
        fs::write(&content, "# new\n").unwrap();
        assert!(bundle.join("assets").is_dir());
        assert!(!bundle.join("text.json").exists());
        let meta: serde_json::Value = serde_json::from_str(&fs::read_to_string(bundle.join("info.json")).unwrap()).unwrap();
        assert_eq!(meta["version"], 2);
        assert_eq!(meta["type"], "net.daringfireball.markdown");
        assert_eq!(meta["transient"], false);
        // Re-ensure keeps the existing content file and never rewrites info.json.
        fs::write(bundle.join("info.json"), "not json").unwrap();
        assert_eq!(ensure_bundle(&bundle).unwrap(), bundle.join("text.md"));
        assert_eq!(fs::read_to_string(bundle.join("info.json")).unwrap(), "not json");
    }

    #[test]
    fn content_file_prefers_text_md_and_ignores_info_json() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("a.textbundle");
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("info.json"), "{\"version\":99}").unwrap(); // never validated
        fs::write(bundle.join("markdown.md"), "# v2\n").unwrap();
        assert_eq!(read_bundle(&bundle).unwrap(), "# v2\n"); // Margin-only fallback
        fs::write(bundle.join("text.markdown"), "# markdown ext\n").unwrap();
        assert_eq!(read_bundle(&bundle).unwrap(), "# markdown ext\n"); // text.* beats markdown.md
        fs::write(bundle.join("text.md"), "# v1\n").unwrap();
        assert_eq!(read_bundle(&bundle).unwrap(), "# v1\n"); // text.md wins when both exist
        fs::write(bundle.join("text.png"), "x").unwrap();
        assert_eq!(content_file(&bundle), bundle.join("text.md"));
        let empty = dir.path().join("e.textbundle");
        fs::create_dir_all(empty.join("text.txt")).unwrap(); // a directory named text.txt is not content
        assert!(read_bundle(&empty).is_err());
        assert_eq!(ensure_bundle(&empty).unwrap(), empty.join("text.md"));
    }
}
