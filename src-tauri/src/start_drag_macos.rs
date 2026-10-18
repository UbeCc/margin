//! macOS: sidebar files dragged out of the window / over our own editor natively (#129).
//!
//! Typora's `controller.startDrag` declares `NSFilenamesPboardType` plus an
//! app-private type on the drag pasteboard and starts a real drag whose image is
//! the file's workspace icon (files-windows-settings §6.4). Margin does the same:
//! JS calls `start_file_drag` while the mouse button is held (after the drag
//! threshold), and the native session serves both Finder targets and in-window
//! drops — our own `drop_macos` hook ignores self-sourced drags, so WebKit turns
//! them into HTML5 drops that carry `text/plain` (the path) for the page.

use objc2::rc::Retained;
use objc2::runtime::{NSObject, ProtocolObject};
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
    NSDragOperation, NSPasteboard, NSPasteboardNameDrag, NSWorkspace,
};
use objc2_foundation::{NSArray, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct DragSource;

    unsafe impl NSObjectProtocol for DragSource {}

    unsafe impl NSDraggingSource for DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn mask(&self, _s: &NSDraggingSession, ctx: NSDraggingContext) -> NSDragOperation {
            if ctx == NSDraggingContext::WithinApplication {
                NSDragOperation::Move | NSDragOperation::Copy
            } else {
                NSDragOperation::Copy
            }
        }
    }
);

impl DragSource {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

pub const PRIVATE_TYPE: &str = "application/x-margin-path";

/// Start a native drag of `paths` from the current mouse event; false when there
/// is no mouse-down in flight (JS only calls this during a row drag gesture).
pub fn start_drag(mtm: MainThreadMarker, paths: &[String]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let app = NSApplication::sharedApplication(mtm);
    let Some(event) = app.currentEvent() else { return false };
    let Some(window) = app.keyWindow() else { return false };
    let Some(view) = window.contentView() else { return false };

    let strings: Vec<Retained<NSString>> = paths.iter().map(|p| NSString::from_str(p)).collect();
    let files = NSArray::from_retained_slice(&strings);
    let files: Retained<objc2::runtime::AnyObject> = unsafe { Retained::cast_unchecked(files) };
    let filenames_ty = NSString::from_str("NSFilenamesPboardType");
    let private_ty = NSString::from_str(PRIVATE_TYPE);
    let text_ty = NSString::from_str("public.utf8-plain-text");
    let types = NSArray::from_slice(&[&*filenames_ty, &*private_ty, &*text_ty]);
    let pb = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
    let _ = unsafe { pb.declareTypes_owner(&types, None) };
    let _ = unsafe { pb.setPropertyList_forType(&files, &filenames_ty) };
    let _ = pb.setString_forType(&strings[0], &private_ty);
    let _ = pb.setString_forType(&strings[0], &text_ty);
    // The dragged image is the first file's workspace icon (Typora does the same).
    let icon = NSWorkspace::sharedWorkspace().iconForFile(&strings[0]);
    icon.setSize(NSSize::new(32.0, 32.0));
    let item = unsafe { NSDraggingItem::new() };
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(32.0, 32.0));
    unsafe { item.setDraggingFrame_contents(frame, Some(&icon)) };
    let items = NSArray::from_retained_slice(&[item]);
    let source: Retained<ProtocolObject<dyn NSDraggingSource>> =
        ProtocolObject::from_retained(DragSource::new(mtm));
    let _ = view.beginDraggingSessionWithItems_event_source(&items, &event, source.as_ref());
    true
}
