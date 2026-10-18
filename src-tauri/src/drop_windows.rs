//! Windows/WebView2: files dragged from other apps onto an editor window (#129).
//!
//! Tauri's drag-drop handler is disabled (it swallows every drag); WebView2 keeps
//! its own OLE drop target on the `Chrome_WidgetWin_*` child HWND, which turns
//! drops into browser-style HTML5 drops (File objects, no paths). That target is
//! wrapped by a chaining one which claims only drags that (a) carry `CF_HDROP`
//! (real files) and (b) do NOT carry Margin's private `application/x-margin-path`
//! clipboard format (the sidebar's in-page HTML5 drag — Chromium registers
//! custom MIME types under their name as clipboard formats). Claimed drags go to
//! the page as `margin://file-drop` (like `drop_macos.rs`); everything else is
//! forwarded to the original WebView2 target untouched.
//!
//! The original target is read from the window property `OleDropTargetInterface`
//! that OLE's `RegisterDragDrop` stores — the long-standing interop technique for
//! chaining OLE drop targets.

use std::cell::Cell;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use windows::core::{implement, Ref};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{
    DVASPECT_CONTENT, FORMATETC, IDataObject, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP, DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragFinish, DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetPropW};

const INTERNAL_FORMAT: windows::core::PCWSTR = windows::core::w!("application/x-margin-path");
const PROP_OLE_DROP_TARGET: windows::core::PCWSTR = windows::core::w!("OleDropTargetInterface");

type Notify = Arc<dyn Fn(Vec<String>, f64, f64) + Send + Sync>;

/// Wrappers must outlive the windows (OLE only holds non-owning refs). COM
/// interface pointers are not `Send` in windows-rs by design; the hook is only
/// ever touched on the UI thread, so this is sound.
#[allow(dead_code)] // keeps the COM wrapper alive; never read
struct KeepTarget(IDropTarget);
unsafe impl Send for KeepTarget {}

static KEEP: LazyLock<Mutex<Vec<KeepTarget>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn hglobal_format(format: u16) -> FORMATETC {
    FORMATETC {
        cfFormat: format,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

/// The drag carries Margin's private format → it started in our own page.
fn is_internal_drag(data: &IDataObject) -> bool {
    let fmt = unsafe { RegisterClipboardFormatW(INTERNAL_FORMAT) };
    fmt != 0 && unsafe { data.GetData(&hglobal_format(fmt as u16)) }.is_ok()
}

/// `CF_HDROP` paths of a drag, or `None` when it carries no files.
fn hdrop_paths(data: &IDataObject) -> Option<Vec<String>> {
    let medium = unsafe { data.GetData(&hglobal_format(CF_HDROP.0)) }.ok()?;
    let hdrop = unsafe { HDROP(medium.u.hGlobal.0 as _) };
    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, None) };
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let len = unsafe { DragQueryFileW(hdrop, i, None) } as usize;
        let mut buf = vec![0u16; len + 1];
        unsafe { DragQueryFileW(hdrop, i, Some(&mut buf)) };
        out.push(String::from_utf16_lossy(&buf[..len]));
    }
    unsafe { DragFinish(hdrop) };
    (!out.is_empty()).then_some(out)
}

#[implement(IDropTarget)]
struct DropHook {
    hwnd: HWND,
    /// Delivery of claimed drops (paths + client CSS-pixel point).
    notify: Notify,
    /// The original WebView2 drop target, chained to for everything else.
    original: Option<IDropTarget>,
    /// The current drag is ours (external files): swallow it from WebView2.
    claimed: Cell<bool>,
}

impl DropHook_Impl {
    fn forward(
        &self,
        f: impl FnOnce(&IDropTarget) -> windows::core::Result<()>,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        match &self.original {
            Some(orig) => f(orig),
            None => {
                unsafe { *effect = DROPEFFECT_NONE };
                Ok(())
            }
        }
    }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for DropHook_Impl {
    fn DragEnter(
        &self,
        data: Ref<'_, IDataObject>,
        key_state: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let external = data.as_ref().is_some_and(|d| hdrop_paths(d).is_some() && !is_internal_drag(d));
        self.claimed.set(external);
        if external {
            unsafe { *effect = DROPEFFECT_COPY };
            return Ok(());
        }
        let (key_state, pt) = (key_state, *pt);
        self.forward(
            |orig| unsafe { orig.DragEnter(data.as_ref(), key_state, pt, effect) },
            effect,
        )
    }

    fn DragOver(
        &self,
        key_state: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if self.claimed.get() {
            unsafe { *effect = DROPEFFECT_COPY };
            return Ok(());
        }
        let (key_state, pt) = (key_state, *pt);
        self.forward(
            |orig| unsafe { orig.DragOver(key_state, pt, effect) },
            effect,
        )
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if self.claimed.replace(false) {
            return Ok(());
        }
        self.forward(|orig| unsafe { orig.DragLeave() }, std::ptr::null_mut())
    }

    fn Drop(
        &self,
        data: Ref<'_, IDataObject>,
        key_state: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if self.claimed.replace(false) {
            if let Some(d) = data.as_ref()
                && let Some(paths) = hdrop_paths(d)
            {
                // Screen point → client device pixels → CSS pixels.
                let mut p = POINT { x: pt.x, y: pt.y };
                let _ = unsafe { ScreenToClient(self.hwnd, &mut p) };
                let scale = SCALE.get().copied().unwrap_or(1.0).max(1.0);
                (self.notify)(paths, p.x as f64 / scale, p.y as f64 / scale);
            }
            unsafe { *effect = DROPEFFECT_COPY };
            return Ok(());
        }
        let (key_state, pt) = (key_state, *pt);
        self.forward(
            |orig| unsafe { orig.Drop(data.as_ref(), key_state, pt, effect) },
            effect,
        )
    }
}

/// Set once per process from the first window (UI scale factor).
static SCALE: std::sync::OnceLock<f64> = std::sync::OnceLock::new();

/// Wrap the OLE drop target registered on `hwnd`, if any.
fn hook_hwnd(hwnd: HWND, notify: Notify) {
    unsafe {
        let prop = GetPropW(hwnd, PROP_OLE_DROP_TARGET);
        if prop.is_invalid() {
            return; // no drop target registered on this window
        }
        // Our own reference before `RevokeDragDrop` drops OLE's.
        let original: IDropTarget =
            windows::core::Interface::from_raw(prop.0 as *mut std::ffi::c_void);
        let _ = RevokeDragDrop(hwnd);
        let hook: IDropTarget = DropHook {
            hwnd,
            notify,
            original: Some(original.clone()),
            claimed: Cell::new(false),
        }
        .into();
        if RegisterDragDrop(hwnd, &hook).is_ok() {
            KEEP.lock().unwrap().push(KeepTarget(hook));
        } else {
            let _ = RegisterDragDrop(hwnd, &original); // keep WebView2 working
        }
    }
}

/// Route external file drags on `window` (and its WebView2 child) to `margin://file-drop`.
pub fn install<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let scale = window.scale_factor().map(|s| s as f64).unwrap_or(1.0);
    let _ = SCALE.set(scale);
    let app = app.clone();
    let label = window.label().to_string();
    let win2 = window.clone();
    let _ = window.with_webview(move |_pw| {
        let notify: Notify = Arc::new(move |paths, x, y| {
            if let Some(win) = app.get_webview_window(&label) {
                crate::emit_file_drop(&win, &paths, x, y);
            }
        });
        let Ok(hwnd) = win2.hwnd() else { return };
        // The webview child carries WebView2's own drop target; the tauri
        // window itself may have none (wry's handler is disabled).
        hook_hwnd(hwnd, notify.clone());
        let mut callback = move |child: HWND| -> bool {
            hook_hwnd(child, notify.clone());
            true
        };
        let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut callback;
        let lparam = LPARAM(&mut trait_obj as *mut _ as usize as isize);
        let _ = unsafe { EnumChildWindows(Some(hwnd), Some(enum_callback), lparam) };
    });
}

unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let closure = unsafe { &mut *(lparam.0 as *mut &mut dyn FnMut(HWND) -> bool) };
    closure(hwnd).into()
}
