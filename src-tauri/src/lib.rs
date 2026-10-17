//! Margin native shell: commands backing `Platform` (src/contracts.ts), native
//! menus, file-open events, close-request veto and window chrome.

mod commands;
mod fsops;
#[cfg(unix)]
mod fsops_unix;
mod images;
mod menu;
#[cfg(target_os = "macos")]
mod pdf_macos;
mod quick_open;
#[doc(hidden)]
pub mod recent;
mod settings;
mod watch;
mod watch_state;
#[cfg(test)]
mod watch_live_tests;
#[cfg(test)]
mod asset_scope_tests;
#[cfg(test)]
mod quick_open_tests;
#[cfg(test)]
mod images_tests;
#[cfg(test)]
mod settings_tests;

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};

pub const MAIN: &str = "main";
pub const EV_MENU: &str = "margin://menu";
pub const EV_FS: &str = "margin://fs-events";
pub const EV_OPEN_FILES: &str = "margin://open-files";
pub const EV_CLOSE_REQUESTED: &str = "margin://close-requested";

#[derive(Default)]
pub struct AppState {
    pub own_writes: Arc<fsops::OwnWrites>,
    pub quick_open: Arc<quick_open::QuickOpen>,
    pub watchers: Mutex<HashMap<u32, watch::Watch>>,
    pub next_watch_id: AtomicU32,
    /// Frontend registered an onCloseRequested handler.
    pub close_guard: AtomicBool,
    /// Frontend approved closing; the next close goes through.
    pub close_confirmed: AtomicBool,
    pub pending_open: Mutex<Vec<String>>,
    pub frontend_ready: AtomicBool,
}

#[derive(Clone, Serialize)]
pub struct FsEventsPayload {
    pub id: u32,
    pub events: Vec<watch::FsEvent>,
}

/// Directories that must never be granted recursively: filesystem roots, the home
/// directory, and the directories that contain all users' homes.
fn is_broad(dir: &Path, home: Option<&Path>) -> bool {
    dir.parent().is_none()
        || home == Some(dir)
        || home.and_then(Path::parent) == Some(dir)
        || [Path::new("/Users"), Path::new("/home"), Path::new("/Volumes"), Path::new("/private"), Path::new("/var")]
            .contains(&dir)
}

/// What to put into the asset scope for `dir`: the lexically normalized path and the
/// canonical one (symlinks, `/var` → `/private/var`). The "too broad" check runs on
/// the *resolved* paths, so `~/notes/..` or a symlink to `/` can't widen the grant.
pub fn asset_grants(dir: &Path, home: Option<&Path>, recursive: bool) -> Vec<(PathBuf, bool)> {
    let lexical = images::normalize(dir);
    let canon = std::fs::canonicalize(&lexical).ok();
    let home_canon = home.and_then(|h| std::fs::canonicalize(h).ok());
    let broad = |p: &Path| is_broad(p, home) || is_broad(p, home_canon.as_deref());
    let any_broad = broad(&lexical) || canon.as_deref().is_some_and(broad);
    let rec = recursive && !any_broad;
    let mut out = vec![(lexical.clone(), rec)];
    if let Some(c) = canon
        && c != lexical
    {
        out.push((c, rec));
    }
    out
}

/// Grant the asset protocol read access for images next to a document/folder.
pub fn allow_assets<R: Runtime>(app: &AppHandle<R>, dir: &Path, recursive: bool) {
    let home = app.path().home_dir().ok();
    let scope = app.asset_protocol_scope();
    for (p, rec) in asset_grants(dir, home.as_deref(), recursive) {
        let _ = scope.allow_directory(&p, rec);
    }
}

pub fn allow_assets_for_file<R: Runtime>(app: &AppHandle<R>, file: &Path) {
    if let Some(parent) = file.parent() {
        allow_assets(app, parent, true);
    }
}

/// Queue or emit files to open (Finder / Dock / CLI).
pub fn open_files<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|p| p.exists())
        .map(|p| {
            allow_assets_for_file(app, &p);
            fsops::path_str(&p)
        })
        .collect();
    if paths.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    if state.frontend_ready.load(Ordering::SeqCst) {
        let _ = app.emit_to(MAIN, EV_OPEN_FILES, paths);
        if let Some(w) = app.get_webview_window(MAIN) {
            let _ = w.set_focus();
        }
    } else {
        state.pending_open.lock().unwrap().extend(paths);
    }
}

fn cli_paths() -> Vec<PathBuf> {
    let args: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect();
    recent::paths_from_args(&args, &std::env::current_dir().unwrap_or_default(), true)
}

/// Another `margin …` was started (Linux file manager, Windows Explorer, CLI): it
/// exits and hands us its arguments.
fn on_second_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>, cwd: String) {
    let paths = recent::paths_from_args(&argv, Path::new(&cwd), true);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    open_files(app, paths);
}

fn request_close<R: Runtime>(app: &AppHandle<R>) -> bool {
    // returns true if the frontend was asked (close must be prevented)
    let state = app.state::<AppState>();
    if state.close_guard.load(Ordering::SeqCst) && !state.close_confirmed.load(Ordering::SeqCst) {
        let _ = app.emit_to(MAIN, EV_CLOSE_REQUESTED, ());
        true
    } else {
        false
    }
}

fn handle_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        menu::ID_QUIT => match app.get_webview_window(MAIN) {
            Some(w) => {
                let _ = w.close(); // goes through CloseRequested → frontend veto
            }
            None => app.exit(0),
        },
        menu::ID_HELP_MARKDOWN => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url("https://commonmark.org/help/", None::<&str>);
        }
        menu::ID_HELP_THEMES_FOLDER => {
            use tauri_plugin_opener::OpenerExt;
            if let Ok(dir) = commands::themes_dir_path(app) {
                let _ = app.opener().open_path(fsops::path_str(&dir), None::<&str>);
            }
        }
        recent::ID_CLEAR => {
            let _ = recent::set_menu(app, &[], &[]);
            let _ = app.emit_to(MAIN, EV_MENU, recent::ID_CLEAR);
        }
        other if other.starts_with(recent::ID_PREFIX) => {
            if let Some(p) = recent::path_for(app, other) {
                open_files(app, vec![PathBuf::from(p)]);
            }
        }
        other => {
            if let Some(theme) = other.strip_prefix("theme:") {
                menu::check_theme(app, theme);
            }
            let _ = app.emit_to(MAIN, EV_MENU, other.to_string());
        }
    }
}

#[cfg(debug_assertions)]
fn maybe_pdf_selftest<R: Runtime>(app: &AppHandle<R>) {
    // `MARGIN_PDF_SELFTEST=/tmp/out.pdf cargo run` renders a long sample document
    // through the real export path and exits (used to verify PDF export on macOS).
    let Ok(out) = std::env::var("MARGIN_PDF_SELFTEST") else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut html = String::from("<!doctype html><meta charset=utf-8><style>body{font:14px -apple-system;margin:0} h1:not(:first-of-type){page-break-before:always} pre{background:#eee}</style><body>");
        // relative image → must resolve through the scoped asset protocol
        if let Some(dir) = PathBuf::from(&out).parent() {
            let _ = std::fs::write(dir.join("margin-selftest dot.svg"), "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><circle cx='60' cy='60' r='50' fill='red'/></svg>");
        }
        html.push_str("<p><img src='margin-selftest%20dot.svg' width=120></p>");
        for i in 1..=6 {
            html.push_str(&format!("<h1>Section {i} — 中文标题</h1>"));
            for j in 0..12 {
                html.push_str(&format!("<p>Paragraph {j}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. 敏捷的棕色狐狸跳过了懒狗。</p>"));
            }
            html.push_str("<pre>fn main() { println!(\"hi\"); }</pre>");
        }
        let res = commands::export_pdf_impl(&app, html, PathBuf::from(&out), None).await;
        eprintln!("MARGIN_PDF_SELFTEST result: {res:?}");
        app.exit(if res.is_ok() { 0 } else { 1 });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // must be the first plugin: a second instance exits before doing anything else
        .plugin(tauri_plugin_single_instance::init(on_second_instance))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(recent::RecentState::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_text_file,
            commands::write_text_file,
            commands::stat,
            commands::list_dir,
            commands::watch,
            commands::unwatch,
            commands::quick_open,
            commands::store_image,
            commands::store_image_bytes,
            commands::open_dialog,
            commands::save_dialog,
            commands::export_html,
            commands::export_pdf,
            commands::print_window,
            commands::load_settings,
            commands::save_settings,
            commands::list_themes,
            commands::themes_dir,
            commands::open_external,
            commands::set_title,
            commands::set_document_edited,
            commands::set_close_guard,
            commands::confirm_close,
            commands::take_pending_open_files,
            commands::allow_asset_dir,
            commands::set_theme_menu,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Menu: built-in themes + user themes, current one ticked.
            let saved = settings::typed(&settings::load(&commands::settings_path(&handle)?));
            let current = saved.theme.clone();
            let mut themes: Vec<String> = menu::BUILTIN_THEMES.iter().map(|s| s.to_string()).collect();
            if let Ok(user) = commands::user_theme_names(&handle) {
                for t in user {
                    if !themes.contains(&t) {
                        themes.push(t);
                    }
                }
            }
            let recents = recent::prepare(&handle, &saved.recent_files, &saved.recent_folders);
            let m = menu::build(&handle, &themes, &current, &recents)?;
            app.set_menu(m)?;
            app.on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));

            if let Ok(dir) = commands::image_fallback_dir(&handle) {
                allow_assets(&handle, &dir, true);
            }
            open_files(&handle, cli_paths());
            #[cfg(debug_assertions)]
            maybe_pdf_selftest(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event
                && request_close(window.app_handle()) {
                    api.prevent_close();
                }
        })
        .build(tauri::generate_context!())
        .expect("error while building Margin");

    app.run(|app, event| match event {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            let paths = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            open_files(app, paths);
        }
        RunEvent::ExitRequested { code: None, api, .. }
            // User-initiated quit (Cmd+Q, Dock) while the editor is open: let the
            // frontend veto through the same close flow.
            if app.get_webview_window(MAIN).is_some() && request_close(app) => {
                api.prevent_exit();
            }
        _ => {}
    });
}
