//! Native clipboard read (#96): Paste as Plain Text from the native menu and
//! RTF paste from rich apps.
//!
//! WKWebView only exposes the pasteboard inside a real `paste` event; a menu
//! command has none, and `navigator.clipboard` needs a user click on WebKit's
//! paste callout. `clipboard_read` returns the general pasteboard's plain text
//! and HTML, and — when a rich app (TextEdit, Pages, Word) put only RTF/RTFD
//! there — HTML converted from it through `NSAttributedString`. RTFD image
//! attachments are materialized into the HTML as `data:` URIs (#114, the way
//! Typora writes them out and remaps `<img src>`, clipboard-contextmenu §3.2);
//! the frontend then routes them through the image storage rule. Other OSes
//! return an empty result and the frontend falls back to the web clipboard API.

use serde::Serialize;

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct ClipboardText {
    pub plain: Option<String>,
    pub html: Option<String>,
    /// HTML generated from `public.rtf` / RTFD (only when no `public.html`).
    pub rtf_html: Option<String>,
    /// `rtf_html` came from RTFD and its attachment images are embedded `data:` URIs.
    pub from_rtfd: bool,
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

    const IMAGE_MIMES: &[(&str, &str)] = &[
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("gif", "image/gif"),
        ("svg", "image/svg+xml"),
        ("bmp", "image/bmp"),
        ("tiff", "image/tiff"),
    ];

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
        if rtfd {
            // #114: materialize attachment images before exporting the HTML.
            let remaps = rename_attachments(&s);
            let html = export_html(&s)?;
            Some(remaps.into_iter().fold(html, |h, (from, to)| h.replace(&from, &to)))
        } else {
            export_html(&s)
        }
    }

    fn export_html(s: &AnyObject) -> Option<String> {
        let len: usize = unsafe { msg_send![s, length] };
        let key = NSString::from_str("DocumentType"); // NSDocumentTypeDocumentAttribute
        let val = NSString::from_str("NSHTML"); // NSHTMLTextDocumentType
        let attrs: Retained<AnyObject> =
            unsafe { msg_send![class!(NSDictionary), dictionaryWithObject: &*val, forKey: &*key] };
        let err = std::ptr::null_mut::<*mut AnyObject>();
        let out: Option<Retained<NSData>> =
            unsafe { msg_send![s, dataFromRange: NSRange::new(0, len), documentAttributes: &*attrs, error: err] };
        let bytes = out?.to_vec();
        String::from_utf8(bytes).ok()
    }

    fn sanitize_name(name: &str) -> String {
        let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
        let cleaned: String = base
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
            .collect();
        let trimmed = cleaned.trim_matches(|c| c == '.' || c == '-');
        if trimmed.is_empty() { "image".into() } else { trimmed.to_string() }
    }

    /// `(extension, mime)` for an attachment image, from the wrapper's
    /// preferred file name when possible and magic bytes otherwise
    /// (`-fileType` no longer exists on modern NSFileWrapper).
    fn image_ext(name: Option<&str>, bytes: &[u8]) -> Option<(&'static str, &'static str)> {
        if let Some(m) = name
            .and_then(|n| n.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()))
            .and_then(|ext| IMAGE_MIMES.iter().find(|&&(e, _)| e == ext))
        {
            return Some(*m);
        }
        let b = bytes;
        Some(match b {
            [0x89, b'P', b'N', b'G', ..] => ("png", "image/png"),
            [0xFF, 0xD8, 0xFF, ..] => ("jpg", "image/jpeg"),
            b if b.starts_with(b"GIF8") => ("gif", "image/gif"),
            b if b.starts_with(b"BM") => ("bmp", "image/bmp"),
            [b'I', b'I', 0x2A, 0x00, ..] | [b'M', b'M', 0x00, 0x2A, ..] => ("tiff", "image/tiff"),
            _ => return None, // not an image we can name: Typora only remaps images
        })
    }

    /// Give every image attachment a unique file name we control and return
    /// `exported src → data: URI` replacements. The HTML writer uses the
    /// wrapper's `preferredFilename` verbatim in `<img src="file:///<name>>"`,
    /// so the rewrite is exact (verified against the Cocoa HTML writer).
    fn rename_attachments(s: &AnyObject) -> Vec<(String, String)> {
        let len: usize = unsafe { msg_send![s, length] };
        let att_key = NSString::from_str("NSAttachment");
        let mut seen: Vec<usize> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        let mut remaps = Vec::new();
        let mut i = 0usize;
        while i < len {
            let mut run = NSRange::new(i, 0);
            let v: Option<Retained<AnyObject>> =
                unsafe { msg_send![s, attribute: &*att_key, atIndex: i, effectiveRange: &mut run] };
            let step = if run.length == 0 { 1 } else { run.location + run.length - i };
            i += step.max(1);
            let Some(att) = v else { continue };
            let ptr = &*att as *const AnyObject as usize;
            if seen.contains(&ptr) {
                continue;
            }
            seen.push(ptr);
            let fw: Option<Retained<AnyObject>> = unsafe { msg_send![&*att, fileWrapper] };
            let Some(fw) = fw else { continue };
            let regular: objc2::runtime::Bool = unsafe { msg_send![&*fw, isRegularFile] };
            if !regular.as_bool() {
                continue;
            }
            let contents: Option<Retained<NSData>> = unsafe { msg_send![&*fw, regularFileContents] };
            let Some(bytes) = contents.filter(|b| !b.is_empty() && b.len() <= MAX) else { continue };
            let pf: Option<Retained<NSString>> = unsafe { msg_send![&*fw, preferredFilename] };
            let pf_s = pf.as_ref().map(|s| s.to_string());
            let Some((ext, mime)) = image_ext(pf_s.as_deref(), &bytes.to_vec()) else {
                continue; // not an image: Typora only remaps images
            };
            let base = sanitize_name(pf.as_deref().map(|s| s.to_string()).as_deref().unwrap_or("image"));
            let stem = base.strip_suffix(&format!(".{ext}")).unwrap_or(&base);
            let mut uniq = format!("{stem}.{ext}");
            let mut n = 2;
            while names.contains(&uniq) {
                uniq = format!("{stem}-{n}.{ext}");
                n += 1;
            }
            names.push(uniq.clone());
            let name = NSString::from_str(&uniq);
            let _: () = unsafe { msg_send![&*fw, setPreferredFilename: &*name] };
            remaps.push((format!("file:///{uniq}"), format!("data:{mime};base64,{}", b64(&bytes.to_vec()))));
        }
        remaps
    }

    /// Standard base64 with padding (no external crate for one call site).
    fn b64(data: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
        for c in data.chunks(3) {
            let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
        }
        out
    }

    pub fn read(pb: &AnyObject) -> ClipboardText {
        let plain = string_for(pb, "public.utf8-plain-text");
        let html = string_for(pb, "public.html");
        let mut from_rtfd = false;
        let rtf_html = if html.is_some() {
            None
        } else if let Some(d) = data_for(pb, "com.apple.flat-rtfd") {
            from_rtfd = true;
            rtf_to_html(&d, true)
        } else {
            data_for(pb, "public.rtf").and_then(|d| rtf_to_html(&d, false))
        };
        ClipboardText { plain, html, rtf_html, from_rtfd }
    }

    pub fn read_general() -> ClipboardText {
        let pb: Option<Retained<AnyObject>> =
            unsafe { msg_send![class!(NSPasteboard), generalPasteboard] };
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
        assert!(!r.from_rtfd);
        let _: () = unsafe { msg_send![&*pb, releaseGlobally] };
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rtfd_attachments_become_data_uris() {
        use super::mac;
        use objc2::rc::Retained;
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{class, msg_send};
        use objc2_foundation::{NSData, NSString};
        // a tiny valid PNG (1x1 transparent)
        const PNG: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0,
            0, 1, 0x08, 0x06, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C,
            0x63, 0, 0x01, 0, 0, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82,
        ];
        let caught = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
            // FileWrapper(regularFileContents: PNG, preferredFilename: "shot.png")
            let png = NSData::with_bytes(PNG);
            let name = NSString::from_str("shot.png");
            let fw_a: objc2::rc::Allocated<AnyObject> = msg_send![class!(NSFileWrapper), alloc];
            let fw: Option<Retained<AnyObject>> = msg_send![fw_a, initRegularFileWithContents: &*png];
            let fw = fw.expect("file wrapper");
            let _: () = msg_send![&*fw, setPreferredFilename: &*name];
            // NSTextAttachment(fileWrapper:) + NSAttributedString(attachment:)
            let att_a: objc2::rc::Allocated<AnyObject> = msg_send![class!(NSTextAttachment), alloc];
            let att: Option<Retained<AnyObject>> = msg_send![att_a, initWithFileWrapper: &*fw];
            let att = att.expect("attachment");
            let img_str: Option<Retained<AnyObject>> =
                msg_send![class!(NSAttributedString), attributedStringWithAttachment: &*att];
            let img_str = img_str.expect("attachment string");
            let s_a: objc2::rc::Allocated<AnyObject> = msg_send![class!(NSMutableAttributedString), alloc];
            let s: Retained<AnyObject> = msg_send![s_a, initWithString: &*NSString::from_str("pic: ")];
            let _: () = msg_send![&*s, appendAttributedString: &*img_str];
            let len: usize = msg_send![&*s, length];
            let empty: Retained<AnyObject> = msg_send![class!(NSDictionary), dictionary];
            let rtfd: Option<Retained<NSData>> =
                msg_send![&*s, RTFDFromRange: objc2_foundation::NSRange::new(0, len), documentAttributes: &*empty];

            let pb: Retained<AnyObject> = msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
            let t = NSString::from_str("com.apple.flat-rtfd");
            let ok: Bool = msg_send![&*pb, setData: &*rtfd.unwrap(), forType: &*t];
            assert!(ok.as_bool());
            let r = mac::read(&pb);
            assert!(r.from_rtfd);
            let h = r.rtf_html.expect("rtfd converted");
            assert!(h.contains("pic:"), "{h}");
            // the attachment was rewritten to a data: URI with our unique name's alt
            assert!(h.contains("src=\"data:image/png;base64,"), "{h}");
            assert!(h.contains("alt=\"shot.png\""), "{h}");
            let _: () = msg_send![&*pb, releaseGlobally];
        }));
        caught.unwrap_or_else(|e| panic!("objc exception: {e:?}"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn empty_off_macos() {
        let r = tauri::async_runtime::block_on(super::clipboard_read()).unwrap();
        assert_eq!(r, super::ClipboardText::default());
    }
}
