//! Quick Look bridge (margin #131, `typora.beh.files.quicklook`).
//!
//! Typora's `window.previewFile(path)` opens the shared `QLPreviewPanel`
//! (files-windows-settings §7). We keep one controller object for the app;
//! it doubles as the panel's data source (one item per preview request) and
//! answers the `QLPreviewPanelController` protocol so AppKit lets the panel
//! take keyboard control. Every Quick Look panel API is main-thread-only,
//! so the command hops over with `WebviewWindow::run_on_main_thread` and
//! waits for it to finish.

#[cfg(target_os = "macos")]
mod sys {
    use std::cell::RefCell;
    use std::sync::{LazyLock, Mutex};

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, define_class, msg_send, AnyThread, DefinedClass};
    use objc2_foundation::{NSObject, NSObjectProtocol, NSString, NSURL};

    // Force-load Quartz.framework: QLPreviewPanel is looked up by class name at
    // runtime and is not linked transitively (same idiom as pdf_post_macos.rs).
    #[link(name = "Quartz", kind = "framework")]
    unsafe extern "C" {}

    struct QlIvars {
        item: RefCell<Option<Retained<NSURL>>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[ivars = QlIvars]
        struct MarginQlController;

        impl MarginQlController {
            // QLPreviewPanelController
            #[unsafe(method(acceptsPreviewPanelControl:))]
            fn accepts_preview_panel_control(&self, _panel: Option<&AnyObject>) -> bool {
                true
            }

            // The shared panel is process-global and outlives us; no need to
            // hold a strong reference while it is under our control.
            #[unsafe(method(beginPreviewPanelControl:))]
            fn begin_preview_panel_control(&self, _panel: Option<&AnyObject>) {}

            #[unsafe(method(endPreviewPanelControl:))]
            fn end_preview_panel_control(&self, _panel: Option<&AnyObject>) {}

            // QLPreviewPanelDataSource
            #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
            fn number_of_preview_items(&self, _panel: Option<&AnyObject>) -> isize {
                isize::from(self.ivars().item.borrow().is_some())
            }

            #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
            fn preview_item_at_index(&self, _panel: Option<&AnyObject>, _index: isize) -> Option<Retained<NSURL>> {
                self.ivars().item.borrow().clone()
            }
        }

        unsafe impl NSObjectProtocol for MarginQlController {}
    );

    impl MarginQlController {
        fn new() -> Retained<Self> {
            let allocated = Self::alloc().set_ivars(QlIvars { item: RefCell::new(None) });
            let obj: Option<Retained<Self>> = unsafe { msg_send![super(allocated), init] };
            obj.expect("MarginQlController init failed")
        }
    }

    struct QlState(Mutex<Retained<MarginQlController>>);
    // SAFETY: the controller (and its NSURL ivar) is only ever used on the
    // main thread — the command dispatches every Quick Look call there. The
    // Mutex merely satisfies the static's Sync bound.
    unsafe impl Send for QlState {}
    unsafe impl Sync for QlState {}

    static CONTROLLER: LazyLock<QlState> = LazyLock::new(|| QlState(Mutex::new(MarginQlController::new())));

    /// Show the shared Quick Look panel for `path` (creates the panel on
    /// first use). Main thread only.
    pub unsafe fn quick_look(path: &str) -> Result<(), String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let controller = CONTROLLER.0.lock().expect("QL controller poisoned").clone();
        *controller.ivars().item.borrow_mut() = Some(url);

        let panel: Option<Retained<AnyObject>> = msg_send![class!(QLPreviewPanel), sharedPreviewPanel];
        let panel = panel.ok_or_else(|| "no QLPreviewPanel".to_string())?;
        let ds: Option<&AnyObject> = Some(controller.as_ref());
        let sender: Option<&AnyObject> = None;
        let _: () = msg_send![&*panel, setDataSource: ds];
        let _: () = msg_send![&*panel, setDelegate: ds];
        let _: () = msg_send![&*panel, reloadData];
        let _: () = msg_send![&*panel, makeKeyAndOrderFront: sender];
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn quick_look_file(path: String, window: tauri::WebviewWindow) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .run_on_main_thread(move || {
            let res = unsafe { sys::quick_look(&path) };
            let _ = tx.send(res);
        })
        .map_err(|e| format!("Quick Look dispatch failed: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "Quick Look timed out".to_string())
        .and_then(|res| res)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn quick_look_file(_path: String, _window: tauri::WebviewWindow) -> Result<(), String> {
    Err("Quick Look is macOS-only".to_string())
}
