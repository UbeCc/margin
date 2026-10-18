//! Linux/WebKitGTK: sidebar files dragged out of the window / over our own editor (#129).
//!
//! The webview starts a GTK drag-source session (`gtk_drag_begin_with_coordinates`,
//! driven by the current button event with `-1, -1` coordinates so GTK reads the
//! pointer position itself) offering `text/uri-list`, plain text and Margin's
//! private target. File managers accept the uri-list; in-window drops keep working
//! because `drop_linux` only claims *external* drags, so this one reaches the page
//! as an HTML5 drag whose payload includes the file path.

use gtk::gdk;
use gtk::prelude::*;
use std::cell::{Cell, RefCell};
use tauri::{Runtime, WebviewWindow};

pub const PRIVATE_TARGET: &str = "application/x-margin-path";

thread_local! {
    static TARGETS: RefCell<Option<gtk::TargetList>> = const { RefCell::new(None) };
    static PATHS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    static HOOKED: Cell<bool> = const { Cell::new(false) };
}

fn target_list() -> gtk::TargetList {
    TARGETS.with(|t| {
        t.borrow_mut()
            .get_or_insert_with(|| {
                let list = gtk::TargetList::new(&[]);
                list.add_uri_targets(0);
                list.add_text_targets(0);
                list.add(&gdk::Atom::intern(PRIVATE_TARGET), 0, 0);
                list
            })
            .clone()
    })
}

/// `file:///home/me/a%20b.md` for the uri-list payload.
pub fn file_uris(paths: &[String]) -> Vec<String> {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'`')
        .add(b'{')
        .add(b'}');
    paths
        .iter()
        .map(|p| format!("file://{}", percent_encoding::utf8_percent_encode(p, SET)))
        .collect()
}

/// Start a native drag of `paths` with the current pointer event; false when no
/// button event is in flight (JS calls this at the drag threshold).
pub fn start_drag<R: Runtime>(win: &WebviewWindow<R>, paths: &[String]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let paths = paths.to_vec();
    let dispatched = win.with_webview(move |pw| {
        let webview = pw.inner();
        let event = gtk::current_event().filter(|e| {
            matches!(e.event_type(), gdk::EventType::ButtonPress | gdk::EventType::DoubleButtonPress | gdk::EventType::MotionNotify)
        });
        if !HOOKED.with(|h| h.replace(true)) {
            // One data provider for every session of this webview.
            webview.connect_drag_data_get(|_w, _ctx, data, _info, _time| {
                let paths = PATHS.with(|p| p.borrow().clone());
                if paths.is_empty() {
                    return;
                }
                let name = data.target().name().map(|n| n.to_string());
                if name.as_deref() == Some(PRIVATE_TARGET) {
                    data.set_text(&paths[0]);
                } else {
                    let uris = file_uris(&paths);
                    let refs: Vec<&str> = uris.iter().map(|s| s.as_str()).collect();
                    data.set_uris(&refs);
                }
            });
        }
        let ctx = webview.drag_begin_with_coordinates(
            &target_list(),
            gdk::DragAction::COPY | gdk::DragAction::MOVE,
            1,
            event.as_ref(),
            -1,
            -1,
        );
        ctx.is_some()
    });
    matches!(dispatched, Ok(true))
}
