//! Appearance › Window Style, applied when a window is created (#134).
//!
//! seamless — content runs under a transparent title bar, no title text
//!           (Typora's macOS default).
//! unibody — transparent, full-size content view with the title visible.
//! native   — the platform's standard titled window ("Classic").

use tauri::{Runtime, WebviewWindow};

/// (titlebar appears transparent, full-size content view, title hidden)
#[cfg(target_os = "macos")]
pub fn style_bits(style: &str) -> (bool, bool, bool) {
    match style {
        "native" => (false, false, false),
        "unibody" => (true, true, false),
        // seamless (default) and anything unknown
        _ => (true, true, true),
    }
}

#[cfg(target_os = "macos")]
pub fn apply<R: Runtime>(win: &WebviewWindow<R>, style: &str) {
    use objc2::msg_send;
    use objc2_app_kit::{NSWindow, NSWindowStyleMask};
    let Ok(ns) = win.ns_window() else { return };
    let nsw: &NSWindow = unsafe { &*(ns as *const NSWindow) };
    let (transparent, full_size, hide_title) = style_bits(style);
    unsafe {
        let mut mask = nsw.styleMask();
        if full_size {
            mask.insert(NSWindowStyleMask::FullSizeContentView);
        } else {
            mask.remove(NSWindowStyleMask::FullSizeContentView);
        }
        nsw.setStyleMask(mask);
        nsw.setTitlebarAppearsTransparent(transparent);
        // NSWindowTitleVisibility: 0 visible, 1 hidden
        let _: () = msg_send![nsw, setTitleVisibility: if hide_title { 1 } else { 0 }];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn apply<R: Runtime>(win: &WebviewWindow<R>, style: &str) {
    // Classic keeps the OS frame; seamless / unibody are borderless on Windows/Linux.
    let _ = win.set_decorations(style == "native");
}

#[cfg(test)]
mod tests {
    use super::style_bits;

    #[test]
    fn styles_map_to_titlebar_bits() {
        // macOS fresh install default is seamless (fe-preferences.md §4.1).
        assert_eq!(style_bits("seamless"), (true, true, true));
        assert_eq!(style_bits("unibody"), (true, true, false));
        assert_eq!(style_bits("native"), (false, false, false));
        assert_eq!(style_bits("anything"), (true, true, true));
    }
}
