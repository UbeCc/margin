//! File › Import via Pandoc (#95, `typora.export.import`): convert docx / odt /
//! epub / rtf / LaTeX / HTML / … to Markdown. argv only (no shell); the input path
//! is passed as a file argument, Markdown comes back on stdout. Embedded media is
//! extracted into a caller-chosen folder (the app's unsaved-images area).

use crate::pandoc::{DEFAULT_TIMEOUT, VERSION_TIMEOUT, detect, fallback_dirs, run};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Pandoc reader for an input file extension.
pub fn reader_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "docx" => "docx",
        "odt" => "odt",
        "epub" => "epub",
        "rtf" => "rtf",
        "tex" | "latex" | "ltx" => "latex",
        "html" | "htm" | "xhtml" => "html",
        "rst" => "rst",
        "textile" => "textile",
        "wiki" | "mediawiki" => "mediawiki",
        "opml" => "opml",
        "org" => "org",
        "ipynb" => "ipynb",
        "csv" => "csv",
        "json" => "json",
        _ => return None,
    })
}

/// Formats whose media pandoc can extract.
fn has_media(reader: &str) -> bool {
    matches!(reader, "docx" | "odt" | "epub")
}

pub fn import_args(input: &Path, reader: &str, media_dir: Option<&Path>) -> Vec<String> {
    let mut a: Vec<String> = vec!["-f".into(), reader.into(), "-t".into(), "gfm".into(), "--wrap=none".into()];
    if let Some(m) = media_dir.filter(|_| has_media(reader)) {
        a.push(format!("--extract-media={}", m.to_string_lossy()));
    }
    a.push("--".into());
    a.push(input.to_string_lossy().into_owned());
    a
}

pub fn import(bin: &Path, input: &Path, media_dir: Option<&Path>, timeout: Duration) -> Result<String, String> {
    if !input.is_absolute() {
        return Err(format!("input path must be absolute: {}", input.display()));
    }
    if !input.is_file() {
        return Err(format!("file not found: {}", input.display()));
    }
    let reader = reader_for(input).ok_or_else(|| format!("Pandoc cannot import {}", input.display()))?;
    let args = import_args(input, reader, media_dir);
    let out = run(bin, &args, None, input.parent(), timeout)?;
    if !out.status.success() {
        let detail: String = out.stderr.trim().chars().take(2000).collect();
        return Err(if detail.is_empty() { format!("Pandoc failed ({})", out.status) } else { format!("Pandoc failed ({}):\n{detail}", out.status) });
    }
    Ok(out.stdout)
}

/// Convert `input_path` to Markdown with Pandoc. Media goes under `<app data>/images/import-<n>`.
#[tauri::command]
pub async fn pandoc_import<Rt: tauri::Runtime>(
    app: tauri::AppHandle<Rt>,
    input_path: String,
    pandoc_path: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let media_root = crate::commands::image_fallback_dir(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        let info = detect(pandoc_path.as_deref(), std::env::var_os("PATH").as_deref(), &fallback_dirs(), VERSION_TIMEOUT)?;
        let input = PathBuf::from(&input_path);
        let media = media_root.map(|r| {
            let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "import".into());
            r.join(format!("import-{}-{stem}", chrono::Local::now().format("%Y%m%d%H%M%S")))
        });
        let timeout = timeout_ms.map(Duration::from_millis).unwrap_or(DEFAULT_TIMEOUT).clamp(Duration::from_secs(1), Duration::from_secs(1800));
        import(Path::new(&info.path), &input, media.as_deref(), timeout)
    })
    .await
    .map_err(|e| format!("pandoc task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readers_by_extension() {
        assert_eq!(reader_for(Path::new("/a/b.DOCX")), Some("docx"));
        assert_eq!(reader_for(Path::new("/a/b.htm")), Some("html"));
        assert_eq!(reader_for(Path::new("/a/b.tex")), Some("latex"));
        assert_eq!(reader_for(Path::new("/a/b.exe")), None);
        assert_eq!(reader_for(Path::new("/a/noext")), None);
    }

    #[test]
    fn argv_has_no_shell_and_ends_options() {
        let a = import_args(Path::new("/x/-rf;rm.docx"), "docx", Some(Path::new("/m")));
        assert_eq!(a, vec!["-f", "docx", "-t", "gfm", "--wrap=none", "--extract-media=/m", "--", "/x/-rf;rm.docx"]);
        let b = import_args(Path::new("/x/a.html"), "html", Some(Path::new("/m")));
        assert!(!b.iter().any(|s| s.starts_with("--extract-media")));
    }

    #[test]
    fn rejects_relative_missing_and_unknown() {
        let bin = Path::new("/bin/echo");
        assert!(import(bin, Path::new("rel.docx"), None, Duration::from_secs(5)).unwrap_err().contains("absolute"));
        assert!(import(bin, Path::new("/nonexistent/x.docx"), None, Duration::from_secs(5)).unwrap_err().contains("not found"));
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.xyz");
        std::fs::write(&f, "x").unwrap();
        assert!(import(bin, &f, None, Duration::from_secs(5)).unwrap_err().contains("cannot import"));
    }

    #[cfg(unix)]
    #[test]
    fn fake_pandoc_stdout_is_the_markdown_and_failures_carry_stderr() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("doc.html");
        std::fs::write(&input, "<h1>Hi</h1>").unwrap();
        let ok = dir.path().join("ok.sh");
        std::fs::write(&ok, "#!/bin/sh\necho \"# converted $2\"\n").unwrap();
        std::fs::set_permissions(&ok, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(import(&ok, &input, None, Duration::from_secs(10)).unwrap(), "# converted html\n");
        let bad = dir.path().join("bad.sh");
        std::fs::write(&bad, "#!/bin/sh\necho 'unknown reader' >&2\nexit 3\n").unwrap();
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = import(&bad, &input, None, Duration::from_secs(10)).unwrap_err();
        assert!(e.contains("unknown reader"), "{e}");
    }

    /// Real pandoc round trip (run with `cargo test -- --ignored` when pandoc is installed).
    #[test]
    #[ignore]
    fn real_pandoc_html_import() {
        let info = detect(None, std::env::var_os("PATH").as_deref(), &fallback_dirs(), VERSION_TIMEOUT).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("doc.html");
        std::fs::write(&input, "<h1>Title</h1><p>Some <strong>bold</strong> text.</p>").unwrap();
        let md = import(Path::new(&info.path), &input, None, Duration::from_secs(60)).unwrap();
        assert!(md.contains("# Title") && md.contains("**bold**"), "{md}");
        // docx round trip: export with pandoc, import back.
        let docx = dir.path().join("rt.docx");
        let req = crate::pandoc::ExportRequest {
            markdown: "# Round Trip\n\n- one\n- two\n".into(),
            out: &docx,
            format: "docx",
            doc_dir: Some(dir.path()),
            title: None,
            timeout: Duration::from_secs(60),
            options: Default::default(),
            cancel: None,
        };
        crate::pandoc::export(Path::new(&info.path), req).unwrap();
        let back = import(Path::new(&info.path), &docx, Some(&dir.path().join("media")), Duration::from_secs(60)).unwrap();
        assert!(back.contains("# Round Trip") && back.contains("one"), "{back}");
    }
}
