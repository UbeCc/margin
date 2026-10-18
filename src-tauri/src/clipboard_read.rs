//! Native clipboard read (#96): Paste as Plain Text from the native menu and
//! RTF paste from rich apps.
//!
//! WKWebView only exposes the pasteboard inside a real `paste` event; a menu
//! command has none, and `navigator.clipboard` needs a user click on WebKit's
//! paste callout. `clipboard_read` returns the general pasteboard's plain text
//! and HTML, and — when a rich app (TextEdit, Pages, Word) put only RTF/RTFD
//! there — HTML converted from it through `NSAttributedString` (attachments of
//! RTFD are not materialized yet). Other OSes return an empty result and the
//! frontend falls back to the web clipboard API.

use serde::Serialize;

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct ClipboardText {
    pub plain: Option<String>,
    pub html: Option<String>,
    /// HTML generated from `public.rtf` / RTFD (only when no `public.html`).
    pub rtf_html: Option<String>,
}

#[tauri::command]
pub async fn clipboard_read() -> Result<ClipboardText, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(mac::read_general).await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(ClipboardText::default())
    }
}

#[cfg(target_os = "macos")]
pub(crate) mod mac {
    use super::ClipboardText;
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSData, NSRange, NSString};

    /// Same cap as the rich-copy path: larger flavours are ignored.
    const MAX: usize = 32 * 1024 * 1024;

    fn string_for(pb: &AnyObject, ty: &str) -> Option<String> {
        let ty = NSString::from_str(ty);
        let s: Option<Retained<NSString>> = unsafe { msg_send![pb, stringForType: &*ty] };
        s.map(|s| s.to_string()).filter(|s| s.len() <= MAX)
    }

    fn data_for(pb: &AnyObject, ty: &str) -> Option<Retained<NSData>> {
        let ty = NSString::from_str(ty);
        let d: Option<Retained<NSData>> = unsafe { msg_send![pb, dataForType: &*ty] };
        d.filter(|d| d.len() <= MAX)
    }

    /// RTF (or RTFD) bytes → HTML via NSAttributedString.
    pub fn rtf_to_html(data: &NSData, rtfd: bool) -> Option<String> {
        let none = std::ptr::null_mut::<*mut AnyObject>();
        let a: Allocated<AnyObject> = unsafe { msg_send![class!(NSAttributedString), alloc] };
        let s: Option<Retained<AnyObject>> = if rtfd {
            unsafe { msg_send![a, initWithRTFD: data, documentAttributes: none] }
        } else {
            unsafe { msg_send![a, initWithRTF: data, documentAttributes: none] }
        };
        let s = s?;
        let len: usize = unsafe { msg_send![&*s, length] };
        let key = NSString::from_str("DocumentType"); // NSDocumentTypeDocumentAttribute
        let val = NSString::from_str("NSHTML"); // NSHTMLTextDocumentType
        let attrs: Retained<AnyObject> = unsafe { msg_send![class!(NSDictionary), dictionaryWithObject: &*val, forKey: &*key] };
        let err = std::ptr::null_mut::<*mut AnyObject>();
        let out: Option<Retained<NSData>> =
            unsafe { msg_send![&*s, dataFromRange: NSRange::new(0, len), documentAttributes: &*attrs, error: err] };
        let bytes = out?.to_vec();
        String::from_utf8(bytes).ok()
    }

    pub fn read(pb: &AnyObject) -> ClipboardText {
        let plain = string_for(pb, "public.utf8-plain-text");
        let html = string_for(pb, "public.html");
        let rtf_html = if html.is_some() {
            None
        } else if let Some(d) = data_for(pb, "com.apple.flat-rtfd") {
            rtf_to_html(&d, true)
        } else {
            data_for(pb, "public.rtf").and_then(|d| rtf_to_html(&d, false))
        };
        ClipboardText { plain, html, rtf_html }
    }

    pub fn read_general() -> ClipboardText {
        let pb: Option<Retained<AnyObject>> = unsafe { msg_send![class!(NSPasteboard), generalPasteboard] };
        pb.map(|pb| read(&pb)).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_plain_html_and_converts_rtf_on_private_pasteboard() {
        use super::mac;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{class, msg_send};
        use objc2_foundation::{NSData, NSString};
        let pb: Retained<AnyObject> = unsafe { msg_send![class!(NSPasteboard), pasteboardWithUniqueName] };
        let set = |ty: &str, v: &str| {
            let (t, v) = (NSString::from_str(ty), NSString::from_str(v));
            let _: isize = unsafe { msg_send![&*pb, clearContents] };
            let ok: Bool = unsafe { msg_send![&*pb, setString: &*v, forType: &*t] };
            assert!(ok.as_bool());
        };
        set("public.utf8-plain-text", "hello");
        let r = mac::read(&pb);
        assert_eq!(r.plain.as_deref(), Some("hello"));
        assert_eq!(r.html, None);
        // RTF only (a rich app's copy) → converted HTML keeps bold
        let _: isize = unsafe { msg_send![&*pb, clearContents] };
        let t = NSString::from_str("public.rtf");
        let d = NSData::with_bytes(b"{\\rtf1\\ansi {\\b Bold} and plain\\par}");
        let ok: Bool = unsafe { msg_send![&*pb, setData: &*d, forType: &*t] };
        assert!(ok.as_bool());
        let r = mac::read(&pb);
        let h = r.rtf_html.expect("rtf converted");
        assert!(h.contains("Bold") && h.contains("and plain"), "{h}");
        assert!(h.contains("font-weight: bold") || h.contains("<b>"), "{h}");
        let _: () = unsafe { msg_send![&*pb, releaseGlobally] };
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn empty_off_macos() {
        let r = tauri::async_runtime::block_on(super::clipboard_read()).unwrap();
        assert_eq!(r, super::ClipboardText::default());
    }
}
