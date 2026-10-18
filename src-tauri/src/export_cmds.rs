//! Export helpers (#95): PDF options (paper, header/footer, bookmarks, metadata),
//! binary export output (Export › Image) and "Open exported file".
// PDF post-processing helpers are only called from the macOS exporter.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// Paper size and margins in points.
#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Paper {
    pub width: f64,
    pub height: f64,
    pub margins: Margins,
}

#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
pub struct OutlineItem {
    pub level: u8,
    pub text: String,
    #[serde(default)]
    pub id: String,
}

#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Meta {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub keywords: String,
}

#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
pub struct PdfOptions {
    pub paper: Option<Paper>,
    pub header: Option<String>,
    pub footer: Option<String>,
    pub outline: Option<Vec<OutlineItem>>,
    pub meta: Option<Meta>,
}

impl PdfOptions {
    /// Paper with sane bounds (36pt..14400pt sides, margins < half the side), else None.
    pub fn checked_paper(&self) -> Option<Paper> {
        let p = self.paper.clone()?;
        let ok_side = |x: f64| x.is_finite() && (36.0..=14_400.0).contains(&x);
        if !ok_side(p.width) || !ok_side(p.height) {
            return None;
        }
        let clamp = |m: f64, side: f64| if m.is_finite() { m.clamp(0.0, side / 2.0 - 1.0) } else { 0.0 };
        Some(Paper {
            width: p.width,
            height: p.height,
            margins: Margins {
                top: clamp(p.margins.top, p.height),
                bottom: clamp(p.margins.bottom, p.height),
                left: clamp(p.margins.left, p.width),
                right: clamp(p.margins.right, p.width),
            },
        })
    }

    pub fn needs_post_processing(&self) -> bool {
        self.header.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.footer.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.outline.as_ref().is_some_and(|o| !o.is_empty())
            || self.meta.is_some()
    }
}

/// Header/footer text for one page: tags stripped, `${pageNo}` (1-based) and `${totalPages}` replaced.
pub fn page_text(template: &str, page_no: usize, total: usize) -> String {
    let mut out = String::with_capacity(template.len());
    let mut in_tag = false;
    for c in template.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("${pageNo}", &page_no.to_string())
        .replace("${totalPages}", &total.to_string())
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .to_string()
}

/// Parent index of each outline item (None = top level), by heading level.
pub fn outline_parents(items: &[OutlineItem]) -> Vec<Option<usize>> {
    let mut stack: Vec<usize> = Vec::new();
    items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            while let Some(&top) = stack.last() {
                if items[top].level < it.level {
                    break;
                }
                stack.pop();
            }
            let parent = stack.last().copied();
            stack.push(i);
            parent
        })
        .collect()
}

/// `#fragment` of a link URL, percent-decoded (for internal link rewriting).
pub fn link_fragment(url: &str) -> Option<String> {
    let frag = url.split_once('#')?.1;
    if frag.is_empty() {
        return None;
    }
    Some(percent_encoding::percent_decode_str(frag).decode_utf8_lossy().into_owned())
}

static EXPORTED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Remember a path written by an export (only those may be opened via `open_exported_file`).
pub fn record_export(p: &Path) {
    EXPORTED.lock().unwrap().get_or_insert_with(HashSet::new).insert(p.to_path_buf());
}

pub fn was_exported(p: &Path) -> bool {
    EXPORTED.lock().unwrap().as_ref().is_some_and(|s| s.contains(p))
}

/// Allowed binary export extensions.
pub fn binary_export_allowed(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(level: u8, t: &str) -> OutlineItem {
        OutlineItem { level, text: t.into(), id: String::new() }
    }

    #[test]
    fn page_text_replaces_and_strips() {
        assert_eq!(page_text("<b>Doc</b> — ${pageNo} / ${totalPages}", 2, 9), "Doc — 2 / 9");
        assert_eq!(page_text("A &amp; B", 1, 1), "A & B");
        assert_eq!(page_text("${title}", 1, 1), "${title}");
    }

    #[test]
    fn outline_parent_tree() {
        let items = [item(1, "a"), item(2, "b"), item(3, "c"), item(2, "d"), item(1, "e"), item(3, "f")];
        assert_eq!(outline_parents(&items), vec![None, Some(0), Some(1), Some(0), None, Some(4)]);
    }

    #[test]
    fn fragments() {
        assert_eq!(link_fragment("asset://localhost/x/#intro").as_deref(), Some("intro"));
        assert_eq!(link_fragment("about:blank#%E4%B8%AD").as_deref(), Some("中"));
        assert_eq!(link_fragment("https://example.com/"), None);
        assert_eq!(link_fragment("https://example.com/#"), None);
    }

    #[test]
    fn paper_bounds() {
        let mut o = PdfOptions::default();
        assert!(o.checked_paper().is_none());
        o.paper = Some(Paper { width: 595.0, height: 842.0, margins: Margins { top: 1000.0, right: 10.0, bottom: -5.0, left: f64::NAN } });
        let p = o.checked_paper().unwrap();
        assert_eq!(p.margins, Margins { top: 420.0, right: 10.0, bottom: 0.0, left: 0.0 });
        o.paper = Some(Paper { width: 1.0, height: 842.0, margins: Margins::default() });
        assert!(o.checked_paper().is_none());
        assert!(!PdfOptions::default().needs_post_processing());
        assert!(PdfOptions { footer: Some("${pageNo}".into()), ..Default::default() }.needs_post_processing());
    }

    #[test]
    fn exported_registry_and_extensions() {
        let p = PathBuf::from("/tmp/margin-export-test.png");
        assert!(!was_exported(&p));
        record_export(&p);
        assert!(was_exported(&p));
        assert!(binary_export_allowed(Path::new("/a/b.JPG")));
        assert!(!binary_export_allowed(Path::new("/a/b.sh")));
        assert!(!binary_export_allowed(Path::new("/a/b")));
    }

    #[test]
    fn options_deserialize_camel() {
        let o: PdfOptions = serde_json::from_str(
            r#"{"paper":{"width":595,"height":842,"margins":{"top":36,"right":36,"bottom":36,"left":36}},"footer":"${pageNo}","outline":[{"level":1,"text":"A","id":"a"}],"meta":{"title":"T","author":"","subject":"","keywords":""}}"#,
        )
        .unwrap();
        assert_eq!(o.outline.unwrap()[0].id, "a");
        assert_eq!(o.meta.unwrap().title, "T");
    }
}

// ------------------------------------------------------------------ commands

use crate::{AppState, fsops};
use tauri::{AppHandle, Runtime, State};

/// Export › Image: raw IPC body = file bytes; header `x-margin-path` = percent-encoded absolute path.
#[tauri::command]
pub async fn export_binary(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-margin-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-margin-path header")?;
    let path = PathBuf::from(percent_encoding::percent_decode_str(raw).decode_utf8().map_err(|e| e.to_string())?.into_owned());
    if !path.is_absolute() {
        return Err(format!("path must be absolute: {}", path.display()));
    }
    if !binary_export_allowed(&path) {
        return Err("only .png / .jpg / .jpeg image exports are allowed".into());
    }
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("expected raw image bytes".into()),
    };
    if bytes.is_empty() {
        return Err("empty image".into());
    }
    let own = state.own_writes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let existed = path.exists();
        fsops::atomic_write(&path, &bytes).map(|_| {
            own.record(&path, existed);
            record_export(&path);
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// "After Export › Open exported file": only paths written by an export in this session.
#[tauri::command]
pub async fn open_exported_file<Rt: Runtime>(app: AppHandle<Rt>, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = PathBuf::from(&path);
    if !was_exported(&p) {
        return Err("refusing to open a file that was not exported in this session".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}
