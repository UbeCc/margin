//! Tauri commands. Argument names are snake_case here and camelCase in JS.
//! Errors are plain strings; `unsupported:` prefixes mark platform gaps the
//! frontend should fall back from.

use crate::images::{self, ImageInput, ImageRule};
use crate::{AppState, EV_FS, FsEventsPayload, MAIN, allow_assets, allow_assets_for_file, fsops, menu, settings, watch};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)
}

fn abs(path: &str) -> R<PathBuf> {
    let p = PathBuf::from(path);
    if p.is_absolute() { Ok(p) } else { Err(format!("path must be absolute: {path}")) }
}

// ------------------------------------------------------------------ files

#[tauri::command]
pub async fn read_text_file<Rt: Runtime>(app: AppHandle<Rt>, path: String) -> R<String> {
    let p = abs(&path)?;
    let text = blocking({
        let p = p.clone();
        move || fsops::read_text(&p)
    })
    .await?
    .map_err(|e| format!("{path}: {e}"))?;
    allow_assets_for_file(&app, &p);
    Ok(text)
}

#[tauri::command]
pub async fn write_text_file<Rt: Runtime>(
    app: AppHandle<Rt>,
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> R<()> {
    let p = abs(&path)?;
    let own = state.own_writes.clone();
    blocking({
        let p = p.clone();
        move || -> std::io::Result<()> {
            let existed = p.exists();
            // record before the rename so the watcher can never see it first
            own.record(&p, existed);
            fsops::atomic_write(&p, content.as_bytes())?;
            own.record(&p, existed);
            Ok(())
        }
    })
    .await?
    .map_err(|e| format!("{path}: {e}"))?;
    allow_assets_for_file(&app, &p);
    Ok(())
}

#[tauri::command]
pub async fn stat(path: String) -> R<Option<fsops::DirEntry>> {
    let p = abs(&path)?;
    blocking(move || fsops::stat(&p)).await
}

#[tauri::command]
pub async fn list_dir<Rt: Runtime>(app: AppHandle<Rt>, path: String) -> R<Vec<fsops::DirEntry>> {
    let p = abs(&path)?;
    let out = blocking({
        let p = p.clone();
        move || fsops::list_dir(&p)
    })
    .await?
    .map_err(|e| format!("{path}: {e}"))?;
    allow_assets(&app, &p, true);
    Ok(out)
}

#[tauri::command]
pub async fn watch<Rt: Runtime>(app: AppHandle<Rt>, state: State<'_, AppState>, path: String) -> R<u32> {
    let root = abs(&path)?;
    let id = state.next_watch_id.fetch_add(1, Ordering::SeqCst) + 1;
    let qo = state.quick_open.clone();
    let app2 = app.clone();
    let w = watch::start(&root, state.own_writes.clone(), move |events| {
        for e in &events {
            match e {
                watch::FsEvent::Created { path } => {
                    let p = Path::new(path);
                    qo.on_created(p, p.is_dir());
                }
                watch::FsEvent::Removed { path } => qo.on_removed(Path::new(path)),
                watch::FsEvent::Renamed { from, to } => {
                    qo.on_removed(Path::new(from));
                    let p = Path::new(to);
                    qo.on_created(p, p.is_dir());
                }
                watch::FsEvent::Modified { .. } => {}
            }
        }
        let _ = app2.emit_to(MAIN, EV_FS, FsEventsPayload { id, events });
    })?;
    state.watchers.lock().unwrap().insert(id, w);
    allow_assets(&app, &root, true);
    Ok(id)
}

#[tauri::command]
pub async fn unwatch(state: State<'_, AppState>, id: u32) -> R<()> {
    let removed = state.watchers.lock().unwrap().remove(&id);
    drop(removed); // stops the debouncer thread
    Ok(())
}

#[tauri::command]
pub async fn quick_open(state: State<'_, AppState>, root: String, query: String, limit: Option<usize>) -> R<Vec<String>> {
    let root = abs(&root)?;
    let watched = state.watchers.lock().unwrap().values().any(|w| root.starts_with(&w.root));
    let qo = state.quick_open.clone();
    blocking(move || qo.search(&root, &query, limit.unwrap_or(50).min(500), watched)).await
}

// ------------------------------------------------------------------ images

pub fn image_fallback_dir<Rt: Runtime>(app: &AppHandle<Rt>) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("images"))
}

fn finish_store<Rt: Runtime>(app: &AppHandle<Rt>, state: &AppState, stored: images::Stored) -> String {
    state.own_writes.record(&stored.abs, false);
    if let Some(dir) = stored.abs.parent() {
        allow_assets(app, dir, false);
    }
    stored.src
}

#[tauri::command]
pub async fn store_image<Rt: Runtime>(
    app: AppHandle<Rt>,
    state: State<'_, AppState>,
    doc_path: Option<String>,
    rule: ImageRule,
    path: String,
) -> R<String> {
    // Remote / data URLs are kept as-is (no download in this version).
    if path.starts_with("http://") || path.starts_with("https://") || path.starts_with("data:") {
        return Ok(path);
    }
    let src = abs(&path)?;
    let doc = doc_path.map(PathBuf::from);
    let fallback = image_fallback_dir(&app)?;
    let home = app.path().home_dir().ok();
    let stored = blocking(move || images::store_image(doc.as_deref(), &rule, ImageInput::File(&src), &fallback, home.as_deref()))
        .await?
        .map_err(err)?;
    Ok(finish_store(&app, &state, stored))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BytesMeta {
    doc_path: Option<String>,
    rule: ImageRule,
    mime: Option<String>,
    name: Option<String>,
}

/// Raw-body variant: the image bytes are the IPC body (no JSON number arrays);
/// metadata travels URL-encoded JSON in the `x-margin-meta` header.
#[tauri::command]
pub async fn store_image_bytes<Rt: Runtime>(
    app: AppHandle<Rt>,
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> R<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    let header = request
        .headers()
        .get("x-margin-meta")
        .and_then(|h| h.to_str().ok())
        .ok_or("missing x-margin-meta header")?;
    let json = percent_encoding::percent_decode_str(header).decode_utf8().map_err(err)?;
    let meta: BytesMeta = serde_json::from_str(&json).map_err(err)?;
    let bytes = bytes.clone();
    let fallback = image_fallback_dir(&app)?;
    let home = app.path().home_dir().ok();
    let stored = blocking(move || {
        let doc = meta.doc_path.map(PathBuf::from);
        images::store_image(
            doc.as_deref(),
            &meta.rule,
            ImageInput::Bytes { data: &bytes, mime: meta.mime.as_deref(), name: meta.name.as_deref() },
            &fallback,
            home.as_deref(),
        )
    })
    .await?
    .map_err(err)?;
    Ok(finish_store(&app, &state, stored))
}

// ------------------------------------------------------------------ dialogs

#[derive(Deserialize, Clone)]
pub struct Filter {
    name: String,
    extensions: Vec<String>,
}

fn markdown_filters() -> Vec<Filter> {
    vec![Filter {
        name: "Markdown".into(),
        extensions: ["md", "markdown", "mdown", "mkd", "mkdn", "txt"].iter().map(|s| s.to_string()).collect(),
    }]
}

#[tauri::command]
pub async fn open_dialog<Rt: Runtime>(
    app: AppHandle<Rt>,
    window: WebviewWindow<Rt>,
    directory: Option<bool>,
    filters: Option<Vec<Filter>>,
) -> R<Option<String>> {
    let directory = directory.unwrap_or(false);
    let mut b = app.dialog().file().set_parent(&window);
    if !directory {
        for f in filters.unwrap_or_else(markdown_filters) {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            b = b.add_filter(&f.name, &exts);
        }
    }
    let picked = blocking(move || if directory { b.blocking_pick_folder() } else { b.blocking_pick_file() }).await?;
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    if directory { allow_assets(&app, &p, true) } else { allow_assets_for_file(&app, &p) }
    Ok(Some(fsops::path_str(&p)))
}

#[tauri::command]
pub async fn save_dialog<Rt: Runtime>(
    app: AppHandle<Rt>,
    window: WebviewWindow<Rt>,
    default_path: Option<String>,
    filters: Option<Vec<Filter>>,
) -> R<Option<String>> {
    let mut b = app.dialog().file().set_parent(&window);
    if let Some(d) = default_path {
        let p = PathBuf::from(&d);
        if p.is_dir() {
            b = b.set_directory(&p);
        } else {
            if let Some(parent) = p.parent().filter(|x| x.is_dir()) {
                b = b.set_directory(parent);
            }
            if let Some(name) = p.file_name() {
                b = b.set_file_name(name.to_string_lossy());
            }
        }
    }
    for f in filters.unwrap_or_else(markdown_filters) {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(&f.name, &exts);
    }
    let picked = blocking(move || b.blocking_save_file()).await?;
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    allow_assets_for_file(&app, &p);
    Ok(Some(fsops::path_str(&p)))
}

// ------------------------------------------------------------------ export

#[tauri::command]
pub async fn export_html(state: State<'_, AppState>, html: String, out_path: String) -> R<()> {
    let p = abs(&out_path)?;
    let own = state.own_writes.clone();
    blocking(move || {
        let existed = p.exists();
        fsops::atomic_write(&p, html.as_bytes()).map(|_| own.record(&p, existed))
    })
    .await?
    .map_err(err)
}

pub async fn export_pdf_impl<Rt: Runtime>(app: &AppHandle<Rt>, html: String, out: PathBuf, base_dir: Option<PathBuf>) -> R<()> {
    #[cfg(target_os = "macos")]
    {
        let base = base_dir.or_else(|| out.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("/"));
        allow_assets(app, &base, true);
        crate::pdf_macos::export_pdf(app, html, base, out).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, html, out, base_dir);
        Err("unsupported: native PDF export is macOS-only; use the print dialog".into())
    }
}

#[tauri::command]
pub async fn export_pdf<Rt: Runtime>(app: AppHandle<Rt>, html: String, out_path: String, base_dir: Option<String>) -> R<()> {
    let out = abs(&out_path)?;
    export_pdf_impl(&app, html, out, base_dir.map(PathBuf::from)).await
}

/// Print the main window's current content (system print dialog).
#[tauri::command]
pub async fn print_window<Rt: Runtime>(window: WebviewWindow<Rt>) -> R<()> {
    window.print().map_err(err)
}

// ------------------------------------------------------------------ settings & themes

pub fn settings_path<Rt: Runtime>(app: &AppHandle<Rt>) -> R<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("settings.json"))
}

#[tauri::command]
pub async fn load_settings<Rt: Runtime>(app: AppHandle<Rt>) -> R<Value> {
    let p = settings_path(&app)?;
    let m = blocking(move || settings::load(&p)).await?;
    Ok(Value::Object(m))
}

#[tauri::command]
pub async fn save_settings<Rt: Runtime>(app: AppHandle<Rt>, settings: Value) -> R<()> {
    let p = settings_path(&app)?;
    let saved = blocking(move || settings::save(&p, settings)).await??;
    if let Some(theme) = saved.get("theme").and_then(Value::as_str) {
        menu::check_theme(&app, theme);
    }
    let typed = settings::typed(&saved);
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = crate::recent::set_menu(&app2, &typed.recent_files, &typed.recent_folders);
    });
    Ok(())
}

pub fn themes_dir_path<Rt: Runtime>(app: &AppHandle<Rt>) -> R<PathBuf> {
    let d = app.path().app_config_dir().map_err(err)?.join("themes");
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

pub fn user_theme_names<Rt: Runtime>(app: &AppHandle<Rt>) -> R<Vec<String>> {
    Ok(read_user_themes(&themes_dir_path(app)?).into_keys().collect())
}

fn read_user_themes(dir: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("css"))
                && let (Some(stem), Ok(css)) = (p.file_stem(), std::fs::read_to_string(&p)) {
                    out.insert(stem.to_string_lossy().into_owned(), css);
                }
        }
    }
    out
}

/// User themes only (`<config>/themes/*.css`); built-ins are bundled by the frontend.
#[tauri::command]
pub async fn list_themes<Rt: Runtime>(app: AppHandle<Rt>) -> R<HashMap<String, String>> {
    let d = themes_dir_path(&app)?;
    allow_assets(&app, &d, true); // themes may reference fonts/images next to them
    blocking(move || read_user_themes(&d)).await
}

#[tauri::command]
pub async fn themes_dir<Rt: Runtime>(app: AppHandle<Rt>) -> R<String> {
    Ok(fsops::path_str(&themes_dir_path(&app)?))
}

#[tauri::command]
pub async fn set_theme_menu<Rt: Runtime>(app: AppHandle<Rt>, names: Vec<String>, current: String) -> R<()> {
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let _ = menu::set_themes(&app2, &names, &current);
    })
    .map_err(err)
}

// ------------------------------------------------------------------ window & misc

#[tauri::command]
pub async fn open_external<Rt: Runtime>(app: AppHandle<Rt>, url: String) -> R<()> {
    use tauri_plugin_opener::OpenerExt;
    let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "mailto") {
        return Err(format!("refusing to open non-web URL scheme: {scheme}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
pub async fn set_title<Rt: Runtime>(window: WebviewWindow<Rt>, title: String) -> R<()> {
    window.set_title(&title).map_err(err)
}

#[tauri::command]
pub async fn set_document_edited<Rt: Runtime>(window: WebviewWindow<Rt>, edited: bool) -> R<()> {
    #[cfg(target_os = "macos")]
    {
        crate::pdf_macos::set_document_edited(&window, edited)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, edited);
        Ok(())
    }
}

#[tauri::command]
pub async fn set_close_guard(state: State<'_, AppState>, enabled: bool) -> R<()> {
    state.close_guard.store(enabled, Ordering::SeqCst);
    Ok(())
}

/// Frontend approved closing after a `margin://close-requested` event.
#[tauri::command]
pub async fn confirm_close<Rt: Runtime>(window: WebviewWindow<Rt>, state: State<'_, AppState>) -> R<()> {
    state.close_confirmed.store(true, Ordering::SeqCst);
    window.destroy().map_err(err)
}

#[tauri::command]
pub async fn take_pending_open_files(state: State<'_, AppState>) -> R<Vec<String>> {
    state.frontend_ready.store(true, Ordering::SeqCst);
    Ok(std::mem::take(&mut *state.pending_open.lock().unwrap()))
}

/// Allow images from one extra directory (non-recursive), e.g. `../shared/img`.
#[tauri::command]
pub async fn allow_asset_dir<Rt: Runtime>(app: AppHandle<Rt>, path: String) -> R<()> {
    let p = abs(&path)?;
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    allow_assets(&app, &p, false);
    Ok(())
}
