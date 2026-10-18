//! Linux/WebKitGTK: files dragged from other apps onto an editor window (#129).
//!
//! Windows are built with Tauri's drag-drop handler disabled (it swallows every
//! drag, including in-page HTML5 drags). WebKitGTK keeps its own HTML5 drag
//! destination on the webview, so internal drags reach the page as before; here
//! we additionally listen to the GtkWidget drag signals and claim only drags
//! that (a) started in another application (source window ≠ ours) and (b)
//! offer `text/uri-list`. Those never reach the page: paths + drop point are
//! sent to the page as `margin://file-drop`, like `drop_macos.rs`.
//!
//! Coordinates: the drag signals report widget coordinates (device px); the
//! page expects CSS px like the macOS hook, so they are divided by the
//! webview's scale factor.

use gtk::{gdk, prelude::*};
use std::cell::Cell;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const URI_LIST: &str = "text/uri-list";

struct DropState {
    /// The current drag is external (another app) and carries files.
    external: Cell<bool>,
    /// `drag_get_data` was called; the next `drag-data-received` is the drop.
    fetching: Cell<bool>,
    /// Drop point of the pending `drag_drop`, in widget (device) pixels.
    at: Cell<(f64, f64)>,
}

/// Percent-decoded path of a `file://` drag URI (non-file URIs are skipped).
pub fn path_from_uri(uri: &str) -> Option<String> {
    let p = uri.strip_prefix("file://")?;
    let p = match p.strip_prefix("localhost/") {
        Some(rest) => rest,
        None if p.starts_with('/') => p,
        _ => return None,
    };
    if p.is_empty() {
        return None;
    }
    Some(
        percent_encoding::percent_decode_str(p)
            .decode_utf8_lossy()
            .into_owned(),
    )
}

fn uri_list_target(ctx: &gdk::DragContext) -> Option<gdk::Atom> {
    ctx.list_targets().into_iter().find(|t| t.name().as_str() == URI_LIST)
}

/// A drag is "external" when its source window is not one of ours. In-page
/// HTML5 drags (and our own `start_drag_linux` sessions) are sourced from the
/// webview's own GDK window or its toplevel.
fn is_external(ctx: &gdk::DragContext, webview: &webkit2gtk::WebView) -> bool {
    let source = ctx.source_window();
    if webview.window().as_ref() == Some(&source) {
        return false;
    }
    !webview.toplevel().is_some_and(|t| t.window().as_ref() == Some(&source))
}

/// Route external file drags on `window`'s webview to `margin://file-drop`.
pub fn install<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let app = app.clone();
    let label = window.label().to_string();
    let _ = window.with_webview(move |pw| {
        let webview = pw.inner();
        let state = std::rc::Rc::new(DropState {
            external: Cell::new(false),
            fetching: Cell::new(false),
            at: Cell::new((0.0, 0.0)),
        });

        let st = state.clone();
        webview.connect_drag_motion(move |w, ctx, _x, _y, time| {
            if is_external(ctx, w) && uri_list_target(ctx).is_some() {
                st.external.set(true);
                ctx.drag_status(gdk::DragAction::COPY, time);
                true // claimed: the page never sees this drag
            } else {
                st.external.set(false);
                false
            }
        });

        let st = state.clone();
        webview.connect_drag_drop(move |w, ctx, x, y, time| {
            if !st.external.get() {
                return false;
            }
            match uri_list_target(ctx) {
                Some(target) => {
                    st.fetching.set(true);
                    st.at.set((x as f64, y as f64));
                    w.drag_get_data(ctx, &target, time);
                    true
                }
                None => false,
            }
        });

        let st = state.clone();
        webview.connect_drag_data_received(move |w, ctx, _x, _y, data, _info, time| {
            if !st.fetching.replace(false) {
                return; // data requested by WebKit's own drag destination
            }
            st.external.set(false);
            ctx.drop_finish(true, time);
            let paths: Vec<String> = data.uris().iter().filter_map(|u| path_from_uri(u.as_str())).collect();
            if paths.is_empty() {
                return;
            }
            let scale = w.scale_factor().max(1) as f64;
            let (x, y) = st.at.get();
            if let Some(app) = app.get_webview_window(&label) {
                crate::emit_file_drop(&app, &paths, x / scale, y / scale);
            }
        });

        webview.connect_drag_leave(move |_w, _ctx, _time| {
            state.external.set(false);
        });
    });
}

#[cfg(test)]
mod tests {
    use super::path_from_uri;

    #[test]
    fn decodes_file_uris() {
        assert_eq!(path_from_uri("file:///tmp/a.md").as_deref(), Some("/tmp/a.md"));
        assert_eq!(
            path_from_uri("file:///home/me/My%20Notes/x%231.md").as_deref(),
            Some("/home/me/My Notes/x#1.md")
        );
        assert_eq!(path_from_uri("file://localhost/etc/hosts").as_deref(), Some("/etc/hosts"));
        assert_eq!(path_from_uri("file:///tmp/%E4%B8%AD%E6%96%87.md").as_deref(), Some("/tmp/中文.md"));
    }

    #[test]
    fn skips_non_file_and_broken_uris() {
        assert_eq!(path_from_uri("https://example.com/a.md"), None);
        assert_eq!(path_from_uri("file://"), None);
        assert_eq!(path_from_uri("file://host.example/path"), None); // non-local host
    }
}
