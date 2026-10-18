//! macOS: File › Get Info opens Finder's own info window for the document, like Typora's
//! `+[PathCommands showFileProperty:]` (`NSPerformService("Finder/Show Info")`,
//! native-commands §2.4).

use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::msg_send;
use objc2_foundation::{NSArray, NSString};

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    fn NSPerformService(item_name: *const AnyObject, pboard: *mut AnyObject) -> Bool;
}

/// Ask Finder to show its info window for `path`. Must run on the main thread.
pub fn show_info(path: &str) -> Result<(), String> {
    unsafe {
        let cls = AnyClass::get(c"NSPasteboard").ok_or("NSPasteboard unavailable")?;
        let pb: *mut AnyObject = msg_send![cls, pasteboardWithUniqueName];
        if pb.is_null() {
            return Err("no pasteboard".into());
        }
        let ty = NSString::from_str("NSFilenamesPboardType");
        let types = NSArray::from_slice(&[&*ty]);
        let _: isize = msg_send![pb, declareTypes: &*types, owner: std::ptr::null_mut::<AnyObject>()];
        let p = NSString::from_str(path);
        let paths = NSArray::from_slice(&[&*p]);
        let ok: Bool = msg_send![pb, setPropertyList: &*paths, forType: &*ty];
        if !ok.as_bool() {
            return Err("could not put the file on the pasteboard".into());
        }
        let service = NSString::from_str("Finder/Show Info");
        let done = NSPerformService(&*service as *const NSString as *const AnyObject, pb);
        let _: () = msg_send![pb, releaseGlobally];
        if done.as_bool() { Ok(()) } else { Err("Finder's Show Info service is unavailable".into()) }
    }
}
