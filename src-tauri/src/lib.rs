//! Margin native shell: commands backing `Platform` (src/contracts.ts), native
//! menus, file-open events, close-request veto and window chrome.

mod commands;
mod fsops;
mod images;
mod menu;
mod pandoc;
#[cfg(target_os = "macos")]
mod pdf_macos;
mod quick_open;
mod settings;
mod watch;

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

/// Grant the asset protocol read access for images next to a document/folder.
/// Directories that are too broad (filesystem root, home itself) are only allowed
/// non-recursively.
pub fn allow_assets<R: Runtime>(app: &AppHandle<R>, dir: &Path, recursive: bool) {
    let home = app.path().home_dir().ok();
    let broad = dir.parent().is_none() || home.as_deref() == Some(dir) || dir == Path::new("/Users") || dir == Path::new("/home");
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(dir, recursive && !broad);
    // FSEvents/realpath style paths (/private/var vs /var) may be requested too.
    if let Ok(canon) = std::fs::canonicalize(dir)
        && canon != dir {
            let _ = scope.allow_directory(&canon, recursive && !broad);
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
    let cwd = std::env::current_dir().unwrap_or_default();
    std::env::args_os()
        .skip(1)
        .filter(|a| !a.to_string_lossy().starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter(|p| p.exists())
        .collect()
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

/// Debug builds only: `MARGIN_E2E_DIR=/tmp/x` makes the app poll `/tmp/x/cmd` and run
/// each line — `menu <action>` (the native menu path, as if the item was clicked) or
/// `eval <js>` (in the main webview). Lets QA drive the real app without Accessibility
/// permissions; results are written back by the JS through the app's own file commands.
#[cfg(debug_assertions)]
fn e2e_driver<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = std::env::var("MARGIN_E2E_DIR") else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let cmd = PathBuf::from(&dir).join("cmd");
        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let Ok(text) = std::fs::read_to_string(&cmd) else { continue };
            let _ = std::fs::remove_file(&cmd);
            for line in text.lines() {
                if let Some(id) = line.strip_prefix("menu ") {
                    let (app2, id) = (app.clone(), id.trim().to_string());
                    let _ = app.run_on_main_thread(move || handle_menu(&app2, &id));
                } else if let Some(js) = line.strip_prefix("eval ") {
                    if let Some(w) = app.get_webview_window(MAIN) {
                        let _ = w.eval(js);
                    }
                } else if let Some(ms) = line.strip_prefix("sleep ") {
                    std::thread::sleep(std::time::Duration::from_millis(ms.trim().parse().unwrap_or(0)));
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
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
            pandoc::pandoc_detect,
            pandoc::pandoc_export,
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
            commands::rename_path,
            commands::trash_path,
            commands::create_dir,
            commands::reveal_path,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Menu: built-in themes + user themes, current one ticked.
            let current = settings::typed(&settings::load(&commands::settings_path(&handle)?)).theme;
            let mut themes: Vec<String> = menu::BUILTIN_THEMES.iter().map(|s| s.to_string()).collect();
            if let Ok(user) = commands::user_theme_names(&handle) {
                for t in user {
                    if !themes.contains(&t) {
                        themes.push(t);
                    }
                }
            }
            let m = menu::build(&handle, &themes, &current)?;
            app.set_menu(m)?;
            app.on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));

            if let Ok(dir) = commands::image_fallback_dir(&handle) {
                allow_assets(&handle, &dir, true);
            }
            open_files(&handle, cli_paths());
            #[cfg(debug_assertions)]
            maybe_pdf_selftest(&handle);
            #[cfg(debug_assertions)]
            e2e_driver(&handle);
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
