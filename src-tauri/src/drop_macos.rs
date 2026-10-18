//! macOS: files dragged from Finder onto an editor window, with real paths (#23).
//!
//! Windows are built with Tauri's drag-drop handler disabled because that handler swallows
//! every drag (including in-page HTML5 drags: tab reorder, sidebar, editor text). With it
//! disabled, WKWebView hands the page `File` objects without paths, so a dropped Markdown
//! file could not be opened. Here the WKWebView subclass's `NSDraggingDestination` methods
//! are swizzled once: drags that come from *another application* and carry file names are
//! handled natively (copy cursor, paths + drop point sent to the page as
//! `margin://file-drop`); everything else goes to the original WebKit implementation.

use objc2::ffi::{class_getInstanceMethod, class_replaceMethod, method_getImplementation, method_getTypeEncoding};
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSString};
use std::sync::{Mutex, Once, OnceLock};
use tauri::{Runtime, WebviewWindow};

/// (NSWindow pointer, paths, x, y in view points from the top-left).
type DropFn = Box<dyn Fn(usize, Vec<String>, f64, f64) + Send + Sync>;
static ON_DROP: OnceLock<DropFn> = OnceLock::new();
static INSTALL: Once = Once::new();
/// Original implementations, by selector name.
static ORIGINAL: Mutex<Vec<(&'static str, usize)>> = Mutex::new(Vec::new());

const NS_DRAG_OPERATION_COPY: usize = 1;

fn original(name: &str) -> Option<usize> {
    ORIGINAL.lock().unwrap().iter().find(|(n, _)| *n == name).map(|(_, imp)| *imp)
}

/// File paths of a drag that started outside this app, or None (internal / non-file drag).
unsafe fn external_files(info: *mut AnyObject) -> Option<Vec<String>> {
    unsafe {
        let source: *mut AnyObject = msg_send![info, draggingSource];
        if !source.is_null() {
            return None; // started in our own webview (HTML5 drag) → WebKit
        }
        let pb: *mut AnyObject = msg_send![info, draggingPasteboard];
        if pb.is_null() {
            return None;
        }
        let ty = NSString::from_str("NSFilenamesPboardType");
        let types = NSArray::from_slice(&[&*ty]);
        let avail: *mut AnyObject = msg_send![pb, availableTypeFromArray: &*types];
        if avail.is_null() {
            return None;
        }
        let list: *mut AnyObject = msg_send![pb, propertyListForType: &*ty];
        if list.is_null() {
            return None;
        }
        let n: usize = msg_send![list, count];
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let s: *mut NSString = msg_send![list, objectAtIndex: i];
            if let Some(s) = s.as_ref() {
                out.push(s.to_string());
            }
        }
        if out.is_empty() { None } else { Some(out) }
    }
}

type OpFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;
type BoolFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;
type VoidFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

unsafe extern "C-unwind" fn entered(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) -> usize {
    unsafe {
        if external_files(info).is_some() {
            return NS_DRAG_OPERATION_COPY;
        }
        let name = if sel == sel!(draggingEntered:) { "draggingEntered:" } else { "draggingUpdated:" };
        match original(name) {
            Some(f) => std::mem::transmute::<usize, OpFn>(f)(this, sel, info),
            None => 0,
        }
    }
}

unsafe extern "C-unwind" fn prepare(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) -> Bool {
    unsafe {
        if external_files(info).is_some() {
            return Bool::YES;
        }
        match original("prepareForDragOperation:") {
            Some(f) => std::mem::transmute::<usize, BoolFn>(f)(this, sel, info),
            None => Bool::NO,
        }
    }
}

unsafe extern "C-unwind" fn perform(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) -> Bool {
    unsafe {
        if let Some(paths) = external_files(info) {
            let loc: NSPoint = msg_send![info, draggingLocation];
            let p: NSPoint = msg_send![this, convertPoint: loc, fromView: std::ptr::null_mut::<AnyObject>()];
            let flipped: bool = msg_send![this, isFlipped];
            let bounds: NSRect = msg_send![this, bounds];
            let y = if flipped { p.y } else { bounds.size.height - p.y };
            let window: *mut AnyObject = msg_send![this, window];
            if let Some(cb) = ON_DROP.get() {
                cb(window as usize, paths, p.x, y);
            }
            return Bool::YES;
        }
        match original("performDragOperation:") {
            Some(f) => std::mem::transmute::<usize, BoolFn>(f)(this, sel, info),
            None => Bool::NO,
        }
    }
}

unsafe extern "C-unwind" fn passthrough(this: *mut AnyObject, sel: Sel, info: *mut AnyObject) {
    unsafe {
        if external_files(info).is_some() {
            return; // WebKit never saw this drag enter
        }
        let name = if sel == sel!(concludeDragOperation:) { "concludeDragOperation:" } else { "draggingExited:" };
        if let Some(f) = original(name) {
            std::mem::transmute::<usize, VoidFn>(f)(this, sel, info);
        }
    }
}

unsafe fn swizzle(cls: *mut AnyClass, name: &'static str, sel: Sel, imp: Imp) {
    unsafe {
        let m = class_getInstanceMethod(cls, sel);
        if m.is_null() {
            return; // not a dragging destination; leave the class alone
        }
        if let Some(old) = method_getImplementation(m) {
            ORIGINAL.lock().unwrap().push((name, old as usize));
        }
        class_replaceMethod(cls, sel, imp, method_getTypeEncoding(m));
    }
}

/// Route Finder drops on `window` (and, after the first call, every window of the same
/// webview class) to `on_drop(window, paths, x, y)`.
pub fn install<R: Runtime>(window: &WebviewWindow<R>, on_drop: impl Fn(usize, Vec<String>, f64, f64) + Send + Sync + 'static) {
    let _ = ON_DROP.set(Box::new(on_drop));
    let _ = window.with_webview(|pw| {
        INSTALL.call_once(|| unsafe {
            let view = pw.inner() as *mut AnyObject;
            if view.is_null() {
                return;
            }
            let cls = (*view).class() as *const AnyClass as *mut AnyClass;
            swizzle(cls, "draggingEntered:", sel!(draggingEntered:), std::mem::transmute::<OpFn, Imp>(entered));
            swizzle(cls, "draggingUpdated:", sel!(draggingUpdated:), std::mem::transmute::<OpFn, Imp>(entered));
            swizzle(cls, "prepareForDragOperation:", sel!(prepareForDragOperation:), std::mem::transmute::<BoolFn, Imp>(prepare));
            swizzle(cls, "performDragOperation:", sel!(performDragOperation:), std::mem::transmute::<BoolFn, Imp>(perform));
            swizzle(cls, "concludeDragOperation:", sel!(concludeDragOperation:), std::mem::transmute::<VoidFn, Imp>(passthrough));
            swizzle(cls, "draggingExited:", sel!(draggingExited:), std::mem::transmute::<VoidFn, Imp>(passthrough));
        });
    });
}
