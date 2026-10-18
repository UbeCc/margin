//! Margin native shell: commands backing `Platform` (src/contracts.ts), native
//! menus, file-open events, close-request veto and window chrome.

mod clipboard_macos;
mod clipboard_read;
mod commands;
mod export_cmds;
mod export_custom;
mod fsops;
#[cfg(unix)]
mod fsops_unix;
mod images;
mod menu;
mod pandoc;
mod pandoc_import;
#[cfg(target_os = "macos")]
mod drop_macos;
#[cfg(target_os = "macos")]
mod pdf_macos;
#[cfg(target_os = "macos")]
mod pdf_post_macos;
mod quick_open;
mod remote_images;
#[doc(hidden)]
pub mod recent;
mod settings;
mod watch;
mod upload;
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
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};

pub const MAIN: &str = "main";
/// Labels of windows opened with File › New Window (#94): `window-1`, `window-2`, …
pub const WINDOW_PREFIX: &str = "window-";
pub const EV_MENU: &str = "margin://menu";
pub const EV_FS: &str = "margin://fs-events";
pub const EV_OPEN_FILES: &str = "margin://open-files";
pub const EV_CLOSE_REQUESTED: &str = "margin://close-requested";
#[cfg(target_os = "macos")]
pub const EV_FILE_DROP: &str = "margin://file-drop";

#[derive(Default)]
pub struct AppState {
    pub own_writes: Arc<fsops::OwnWrites>,
    pub quick_open: Arc<quick_open::QuickOpen>,
    pub watchers: Mutex<HashMap<u32, watch::Watch>>,
    pub next_watch_id: AtomicU32,
    /// Windows whose frontend registered an onCloseRequested handler (#94: per window).
    pub guarded: Mutex<HashSet<String>>,
    /// Windows whose frontend approved closing; their next close goes through.
    pub confirmed: Mutex<HashSet<String>>,
    pub next_window: AtomicU32,
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
/// Window that receives menu actions and opened files: the focused one, else main, else any.
pub fn target_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    let all = app.webview_windows();
    all.values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| all.get(MAIN))
        .or_else(|| all.values().next())
        .cloned()
}

fn target_label<R: Runtime>(app: &AppHandle<R>) -> String {
    target_window(app).map(|w| w.label().to_string()).unwrap_or_else(|| MAIN.to_string())
}

/// Minimal percent-encoding for a query value.
pub fn query_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// URL of a secondary editor window (`window=new`, optional file to open).
pub fn window_url(path: Option<&str>) -> String {
    match path {
        Some(p) => format!("index.html?window=new&open={}", query_escape(p)),
        None => "index.html?window=new".to_string(),
    }
}

/// Create an editor window like the main one (same size/style, macOS tabbing group).
pub fn new_window<R: Runtime>(app: &AppHandle<R>, label: &str, path: Option<&str>) -> tauri::Result<()> {
    let url = tauri::WebviewUrl::App(window_url(path).into());
    let mut b = tauri::WebviewWindowBuilder::new(app, label, url)
        .title("Margin")
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 360.0)
        .resizable(true)
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(tauri::TitleBarStyle::Transparent).tabbing_identifier("margin");
    }
    if let Some(cur) = target_window(app)
        && let Ok(pos) = cur.outer_position()
    {
        // cascade from the current window
        let scale = cur.scale_factor().unwrap_or(1.0);
        let p = pos.to_logical::<f64>(scale);
        b = b.position(p.x + 28.0, p.y + 28.0);
    }
    b.build().map(|_| ())
}

/// Payload of `margin://file-drop` (#23): `FileDrop` in src/contracts.ts.
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
pub struct FileDrop {
    pub paths: Vec<String>,
    pub x: f64,
    pub y: f64,
}

/// Finder files dropped on the window whose NSWindow is `ns_window` (#23).
#[cfg(target_os = "macos")]
fn file_dropped<R: Runtime>(app: &AppHandle<R>, ns_window: usize, paths: Vec<String>, x: f64, y: f64) {
    let Some(win) = app
        .webview_windows()
        .into_values()
        .find(|w| w.ns_window().map(|p| p as usize == ns_window).unwrap_or(false))
    else {
        return;
    };
    for p in &paths {
        allow_assets_for_file(app, Path::new(p));
    }
    let _ = win.set_focus();
    let _ = app.emit_to(win.label(), EV_FILE_DROP, FileDrop { paths, x, y });
}

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
        let label = target_label(app);
        let _ = app.emit_to(label.as_str(), EV_OPEN_FILES, paths);
        if let Some(w) = app.get_webview_window(&label) {
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
    if let Some(w) = target_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    open_files(app, paths);
}

/// Ask window `label`'s frontend to confirm closing (unsaved changes).
/// Returns true if the frontend was asked (close must be prevented for now).
fn request_close<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    let state = app.state::<AppState>();
    let guarded = state.guarded.lock().unwrap().contains(label);
    if guarded && !state.confirmed.lock().unwrap().contains(label) {
        let _ = app.emit_to(label, EV_CLOSE_REQUESTED, ());
        true
    } else {
        false
    }
}

/// Cmd+Q / Dock quit: every window with unsaved changes is asked; true = exit vetoed.
fn veto_exit<R: Runtime>(app: &AppHandle<R>) -> bool {
    let labels: Vec<String> = app.webview_windows().into_keys().collect();
    let mut veto = false;
    for l in labels {
        veto |= request_close(app, &l);
    }
    veto
}

fn handle_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        menu::ID_QUIT => {
            let windows: Vec<_> = app.webview_windows().into_values().collect();
            if windows.is_empty() {
                app.exit(0);
            }
            for w in windows {
                let _ = w.close(); // goes through CloseRequested → each frontend may veto
            }
        }
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
            let _ = app.emit_to(target_label(app).as_str(), EV_MENU, recent::ID_CLEAR);
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
            let _ = app.emit_to(target_label(app).as_str(), EV_MENU, other.to_string());
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
            html.push_str(&format!("<p><a href='#s{i}'>Go to section {i}</a></p><h1 id='s{i}'>Section {i} — 中文标题</h1>"));
            for j in 0..12 {
                html.push_str(&format!("<p>Paragraph {j}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. 敏捷的棕色狐狸跳过了懒狗。</p>"));
            }
            html.push_str("<pre>fn main() { println!(\"hi\"); }</pre>");
        }
        // Optional PDF options (#95), e.g. MARGIN_PDF_SELFTEST_OPTS='{"footer":"${pageNo} / ${totalPages}"}'.
        let opts = std::env::var("MARGIN_PDF_SELFTEST_OPTS")
            .ok()
            .and_then(|j| serde_json::from_str::<export_cmds::PdfOptions>(&j).ok())
            .unwrap_or_default();
        let res = commands::export_pdf_impl(&app, html, PathBuf::from(&out), None, opts).await;
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
            pandoc::pandoc_detect,
            pandoc::pandoc_export,
            pandoc::pandoc_abort,
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
            commands::open_window,
            commands::read_file_bytes,
            commands::allow_asset_dir,
            commands::set_theme_menu,
            commands::relocate_images,
            commands::rename_path,
            commands::trash_path,
            commands::create_dir,
            commands::reveal_path,
            export_cmds::export_binary,
            export_cmds::open_exported_file,
            pandoc_import::pandoc_import,
            export_custom::run_export_command,
            upload::upload_images,
            clipboard_macos::clipboard_write_rich,
            clipboard_read::clipboard_read,
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
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("main") {
                let h = handle.clone();
                drop_macos::install(&w, move |win, paths, x, y| file_dropped(&h, win, paths, x, y));
            }
            #[cfg(debug_assertions)]
            maybe_pdf_selftest(&handle);
            #[cfg(debug_assertions)]
            e2e_driver(&handle);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if request_close(window.app_handle(), window.label()) {
                    api.prevent_close();
                }
            }
            WindowEvent::Destroyed => {
                let state = window.app_handle().state::<AppState>();
                state.guarded.lock().unwrap().remove(window.label());
                state.confirmed.lock().unwrap().remove(window.label());
            }
            _ => {}
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
            if veto_exit(app) => {
                api.prevent_exit();
            }
        _ => {}
    });
}

#[cfg(test)]
mod window_tests {
    use super::*;

    #[test]
    fn new_window_url_carries_the_file_escaped() {
        assert_eq!(window_url(None), "index.html?window=new");
        assert_eq!(
            window_url(Some("/Users/me/My Notes/中文 & #1.md")),
            "index.html?window=new&open=/Users/me/My%20Notes/%E4%B8%AD%E6%96%87%20%26%20%231.md"
        );
    }

    #[test]
    fn close_guards_are_per_window() {
        let app = tauri::test::mock_app();
        app.manage(AppState::default());
        let h = app.handle();
        let st = h.state::<AppState>();
        st.guarded.lock().unwrap().insert("window-1".into());
        assert!(request_close(h, "window-1"), "guarded window asks its frontend");
        assert!(!request_close(h, MAIN), "unguarded window closes directly");
        st.confirmed.lock().unwrap().insert("window-1".into());
        assert!(!request_close(h, "window-1"), "confirmed window closes");
    }
}
