//! Rich copy (#79): add `public.rtf` to the macOS general pasteboard.
//!
//! WKWebView's `DataTransfer` can only write `text/plain`, `text/html` and
//! custom types (WebKit-private blob), never RTF. The frontend lets WebKit write
//! its flavours in the `copy` event, then calls `clipboard_write_rich` with the
//! RTF it generated and a nonce that is embedded in the HTML flavour.
//!
//! * Append mode: once `public.html` on the pasteboard contains the nonce,
//!   `addTypes:owner:` + `setData:forType:` add RTF without clearing, so
//!   WebKit's own data (including the custom-type blob) survives.
//! * Fallback: if the nonce never shows up (WebKit wrote nothing we recognise)
//!   and nobody else changed the pasteboard, write plain/HTML/RTF ourselves.
//! * A newer copy (different HTML, changed changeCount) is never clobbered.
//!
//! On other OSes the command is a no-op returning `false`; the module compiles
//! everywhere so `generate_handler!` stays platform-independent.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct RichClipboardData {
    pub plain: String,
    pub html: String,
    pub rtf: String,
    pub markdown: String,
    pub marker: String,
    /// #115: document URL used as the WebArchive base ("untitled.md" when unsaved).
    #[serde(default, rename = "baseUrl")]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub base_url: String,
}

/// #116: flavours for a direct native write — used when WKWebView refuses
/// `document.execCommand("copy")` (native-menu Copy-as without a webview
/// user activation). Mirrors Typora's `clipboard.write` with shouldClear.
#[derive(Debug, Default, Deserialize)]
pub struct NativeClipboardData {
    pub plain: String,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub markdown: Option<String>,
    #[serde(default)]
    pub rtf: Option<String>,
    #[serde(default, rename = "baseUrl")]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub base_url: String,
}

/// Upper bound on any single flavour (bytes); larger copies keep WebKit's flavours only.
const MAX_FLAVOR_BYTES: usize = 32 * 1024 * 1024;
/// Validate the payload independent of the platform (unit-tested on Linux CI).
pub fn validate(d: &RichClipboardData) -> Result<(), String> {
    if d.marker.is_empty() || d.marker.len() > 128 || !d.html.contains(&d.marker) {
        return Err("clipboard marker missing from html".into());
    }
    if !d.rtf.starts_with("{\\rtf1") {
        return Err("not an RTF document".into());
    }
    for s in [&d.plain, &d.html, &d.rtf, &d.markdown] {
        if s.len() > MAX_FLAVOR_BYTES {
            return Err("clipboard flavour too large".into());
        }
    }
    Ok(())
}

/// Validate the #116 payload independent of the platform (unit-tested on Linux CI).
pub fn validate_native(d: &NativeClipboardData) -> Result<(), String> {
    let empty = d.plain.is_empty()
        && d.html.as_deref().unwrap_or("").is_empty()
        && d.markdown.as_deref().unwrap_or("").is_empty()
        && d.rtf.as_deref().unwrap_or("").is_empty();
    if empty {
        return Err("clipboard payload is empty".into());
    }
    for s in [Some(d.plain.as_str()), d.html.as_deref(), d.markdown.as_deref(), d.rtf.as_deref()]
        .into_iter()
        .flatten()
    {
        if s.len() > MAX_FLAVOR_BYTES {
            return Err("clipboard flavour too large".into());
        }
    }
    Ok(())
}

/// `com.apple.webarchive` payload (#115): a binary property list wrapping the
/// copied HTML with the document URL as base, so relative image paths resolve
/// in other apps (Typora `convertHtmlToWebArchieve:`, clipboard-contextmenu §3.4).
#[cfg(any(test, target_os = "macos"))]
pub fn webarchive(html: &str, base_url: &str) -> Option<Vec<u8>> {
    let url = if base_url.is_empty() { "untitled.md" } else { base_url };
    let main = plist::Dictionary::from_iter([
        ("WebResourceData", plist::Value::Data(html.as_bytes().to_vec())),
        ("WebResourceURL", plist::Value::String(url.to_string())),
        ("WebResourceMIMEType", plist::Value::String("text/html".into())),
        ("WebResourceTextEncodingName", plist::Value::String("utf-8".into())),
        ("WebResourceFrameName", plist::Value::String(String::new())),
    ]);
    let mut root = plist::Dictionary::new();
    root.insert("WebMainResource".into(), plist::Value::Dictionary(main));
    let mut out = Vec::new();
    plist::Value::Dictionary(root).to_writer_binary(&mut out).ok()?;
    Some(out)
}

#[tauri::command]
pub async fn clipboard_write_rich(data: RichClipboardData) -> Result<bool, String> {
    validate(&data)?;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || mac::write(&data))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = data;
        Ok(false)
    }
}

/// #116: overwrite the pasteboard with the given flavours (no WebKit round-trip).
#[tauri::command]
pub async fn clipboard_write_payload(data: NativeClipboardData) -> Result<bool, String> {
    validate_native(&data)?;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || mac::write_payload(&data))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = data;
        Ok(false)
    }
}
/// #136 `clipboard.writeImage`: put a local image file on the pasteboard as
/// PNG + TIFF (Typora writes `addTypes:@[PNG,TIFF]` + `writeObjects:@[image]`).
#[tauri::command]
pub async fn clipboard_write_image(path: String) -> Result<bool, String> {
    if path.is_empty() {
        return Err("no image path".into());
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || mac::write_image(&path))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{NativeClipboardData, RichClipboardData};
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::{NSData, NSRange, NSString};
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_millis(400);
    const POLL: Duration = Duration::from_millis(15);

    fn board() -> Option<Retained<AnyObject>> {
        unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
    }

    fn change_count(pb: &AnyObject) -> isize {
        unsafe { msg_send![pb, changeCount] }
    }

    pub(super) fn string_for(pb: &AnyObject, ty: &str) -> Option<String> {
        let ty = NSString::from_str(ty);
        let s: Option<Retained<NSString>> = unsafe { msg_send![pb, stringForType: &*ty] };
        s.map(|s| s.to_string())
    }

    pub(super) fn set_string(pb: &AnyObject, ty: &str, value: &str) -> bool {
        let (ty, v) = (NSString::from_str(ty), NSString::from_str(value));
        let ok: Bool = unsafe { msg_send![pb, setString: &*v, forType: &*ty] };
        ok.as_bool()
    }

    fn set_data(pb: &AnyObject, ty: &str, bytes: &[u8]) -> bool {
        let ty = NSString::from_str(ty);
        let data = NSData::with_bytes(bytes);
        let ok: Bool = unsafe { msg_send![pb, setData: &*data, forType: &*ty] };
        ok.as_bool()
    }

    fn add_type(pb: &AnyObject, ty: &str) {
        let ty = NSString::from_str(ty);
        let arr: Retained<AnyObject> = unsafe { msg_send![class!(NSArray), arrayWithObject: &*ty] };
        let none: *const AnyObject = std::ptr::null();
        let _: isize = unsafe { msg_send![pb, addTypes: &*arr, owner: none] };
    }

    /// #115: `public.rtfd` bytes. Typora derives RTF and RTFD from one
    /// NSAttributedString built from the copied HTML; Margin re-reads the
    /// JS-generated RTF (same content, `\pict` images become attachments) and
    /// exports it as flat RTFD. RTF import needs no WebKit, so this runs off
    /// the main thread (HTML import would require it).
    fn rtf_to_rtfd(rtf: &str) -> Option<Vec<u8>> {
        let data = NSData::with_bytes(rtf.as_bytes());
        let none = std::ptr::null_mut::<*mut AnyObject>();
        let a: Allocated<AnyObject> = unsafe { msg_send![class!(NSAttributedString), alloc] };
        let s: Option<Retained<AnyObject>> =
            unsafe { msg_send![a, initWithRTF: &*data, documentAttributes: none] };
        let s = s?;
        let len: usize = unsafe { msg_send![&*s, length] };
        let key = NSString::from_str("DocumentType"); // NSDocumentTypeDocumentAttribute
        let val = NSString::from_str("NSRTFD"); // NSRTFDTextDocumentType
        let attrs: Retained<AnyObject> =
            unsafe { msg_send![class!(NSDictionary), dictionaryWithObject: &*val, forKey: &*key] };
        let err = std::ptr::null_mut::<*mut AnyObject>();
        let out: Option<Retained<NSData>> = unsafe {
            msg_send![&*s, dataFromRange: NSRange::new(0, len), documentAttributes: &*attrs, error: err]
        };
        Some(out?.to_vec())
    }

    /// Typora's postCopy order after the nonce round: webarchive → RTFD → RTF
    /// (clipboard-contextmenu §3.4; `public.html` is already on the board).
    fn append_rich(pb: &AnyObject, d: &RichClipboardData) -> bool {
        for t in ["com.apple.webarchive", "public.rtfd", "public.rtf"] {
            add_type(pb, t);
        }
        let mut ok = false;
        if let Some(wa) = super::webarchive(&d.html, &d.base_url) {
            ok |= set_data(pb, "com.apple.webarchive", &wa);
        }
        if let Some(rtfd) = rtf_to_rtfd(&d.rtf) {
            ok |= set_data(pb, "public.rtfd", &rtfd);
        }
        ok |= set_data(pb, "public.rtf", d.rtf.as_bytes());
        ok
    }

    pub fn write(d: &RichClipboardData) -> bool {
        match board() {
            Some(pb) => write_to(&pb, d, WAIT),
            None => false,
        }
    }

    pub(super) fn write_to(pb: &AnyObject, d: &RichClipboardData, wait: Duration) -> bool {
        let start = change_count(pb);
        let deadline = Instant::now() + wait;
        loop {
            match string_for(pb, "public.html") {
                Some(h) if h.contains(&d.marker) => return append_rich(pb, d),
                Some(_) if change_count(pb) != start => return false, // a newer copy landed
                _ => {}
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(POLL);
        }
        // WebKit's write never showed up; write every flavour ourselves unless the
        // pasteboard moved on meanwhile.
        if change_count(pb) != start {
            return false;
        }
        let _: isize = unsafe { msg_send![pb, clearContents] };
        let mut ok = set_string(pb, "public.utf8-plain-text", &d.plain);
        ok &= set_string(pb, "public.html", &d.html);
        if let Some(wa) = super::webarchive(&d.html, &d.base_url) {
            ok &= set_data(pb, "com.apple.webarchive", &wa);
        }
        if let Some(rtfd) = rtf_to_rtfd(&d.rtf) {
            ok &= set_data(pb, "public.rtfd", &rtfd);
        }
        ok &= set_data(pb, "public.rtf", d.rtf.as_bytes());
        ok
    }

    /// #116: plain overwrite with the given flavours (Typora `write:afterClear:`).
    pub fn write_payload(d: &NativeClipboardData) -> bool {
        match board() {
            Some(pb) => write_payload_to(&pb, d),
            None => false,
        }
    }

    pub(super) fn write_payload_to(pb: &AnyObject, d: &NativeClipboardData) -> bool {
        let _: isize = unsafe { msg_send![pb, clearContents] };
        let mut ok = set_string(pb, "public.utf8-plain-text", &d.plain);
        if let Some(h) = &d.html {
            ok &= set_string(pb, "public.html", h);
            if let Some(wa) = super::webarchive(h, &d.base_url) {
                ok &= set_data(pb, "com.apple.webarchive", &wa);
            }
        }
        if let Some(rtf) = &d.rtf {
            ok &= set_data(pb, "public.rtf", rtf.as_bytes());
            if let Some(rtfd) = rtf_to_rtfd(rtf) {
                ok &= set_data(pb, "public.rtfd", &rtfd);
            }
        }
        if let Some(m) = &d.markdown {
            ok &= set_string(pb, "net.daringfireball.markdown", m);
        }
        ok
    }

    #[cfg(test)]
    /// Raw bytes of a flavour (tests).
    pub(super) fn data_bytes(pb: &AnyObject, ty: &str) -> Option<Vec<u8>> {
        let ty = NSString::from_str(ty);
        let d: Option<Retained<NSData>> = unsafe { msg_send![pb, dataForType: &*ty] };
        d.map(|d| d.to_vec())
    }

    /// NSImage from a local file → pasteboard (PNG + TIFF types, then the object).
    pub fn write_image(path: &str) -> Result<bool, String> {
        let pb = board().ok_or("no pasteboard")?;
        let p = NSString::from_str(path);
        let img: Option<Retained<AnyObject>> = unsafe { msg_send![class!(NSImage), imageWithContentsOfFile: &*p] };
        let img = img.ok_or_else(|| format!("could not read an image from {path}"))?;
        unsafe {
            let _: isize = msg_send![&*pb, clearContents];
            add_type(&pb, "public.png");
            add_type(&pb, "public.tiff");
            let objs: Retained<AnyObject> = msg_send![class!(NSArray), arrayWithObject: &*img];
            let ok: Bool = msg_send![&*pb, writeObjects: &*objs];
            Ok(ok.as_bool())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> RichClipboardData {
        RichClipboardData {
            plain: "**a**".into(),
            html: "<div data-margin-md=\"**a**\" data-margin-copy=\"n1\"><p><strong>a</strong></p></div>".into(),
            rtf: "{\\rtf1\\ansi {\\b a}\\par}".into(),
            markdown: "**a**".into(),
            marker: "n1".into(),
            base_url: "file:///tmp/n1.md".into(),
        }
    }

    #[test]
    fn validates_payload() {
        assert!(validate(&data()).is_ok());
        let mut d = data();
        d.marker = "zz".into();
        assert!(validate(&d).is_err());
        let mut d = data();
        d.rtf = "plain".into();
        assert!(validate(&d).is_err());
        let mut d = data();
        d.marker.clear();
        assert!(validate(&d).is_err());
        // #116 native payload
        assert!(validate_native(&NativeClipboardData { plain: "x".into(), ..Default::default() }).is_ok());
        assert!(validate_native(&NativeClipboardData { plain: String::new(), ..Default::default() }).is_err());
    }

    /// #115: the webarchive is a binary plist whose main resource carries the
    /// copied HTML and the document URL as base (untitled.md when unsaved).
    #[test]
    fn webarchive_wraps_html_with_doc_base() {
        let wa = webarchive("<p>héllo</p>", "file:///tmp/a%20b.md").unwrap();
        assert!(wa.starts_with(b"bplist00"));
        let v = plist::Value::from_reader(std::io::Cursor::new(&wa)).unwrap();
        let main = v.as_dictionary().unwrap().get("WebMainResource").unwrap().as_dictionary().unwrap();
        let data = main.get("WebResourceData").unwrap().as_data().unwrap();
        assert_eq!(data, b"<p>h\xc3\xa9llo</p>");
        assert_eq!(main.get("WebResourceURL").unwrap().as_string().unwrap(), "file:///tmp/a%20b.md");
        assert_eq!(main.get("WebResourceMIMEType").unwrap().as_string().unwrap(), "text/html");
        assert_eq!(main.get("WebResourceTextEncodingName").unwrap().as_string().unwrap(), "utf-8");
        // unsaved document → Typora's "untitled.md" base
        let wa = webarchive("<p>x</p>", "").unwrap();
        let v = plist::Value::from_reader(std::io::Cursor::new(&wa)).unwrap();
        let main = v.as_dictionary().unwrap().get("WebMainResource").unwrap().as_dictionary().unwrap();
        assert_eq!(main.get("WebResourceURL").unwrap().as_string().unwrap(), "untitled.md");
    }

    /// Exercises the real NSPasteboard calls on a private, uniquely named
    /// pasteboard (never the user's general clipboard).
    #[cfg(target_os = "macos")]
    #[test]
    fn appends_rtf_or_writes_all_on_private_pasteboard() {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use std::time::Duration;
        let pb: Retained<AnyObject> =
            unsafe { msg_send![class!(NSPasteboard), pasteboardWithUniqueName] };
        let d = data();
        // nothing from WebKit → fallback writes every flavour
        assert!(mac::write_to(&pb, &d, Duration::from_millis(30)));
        assert_eq!(
            mac::string_for(&pb, "public.html").as_deref(),
            Some(d.html.as_str())
        );
        assert_eq!(
            mac::string_for(&pb, "public.utf8-plain-text").as_deref(),
            Some("**a**")
        );
        // WebKit-like write present → webarchive + RTFD + RTF appended, HTML untouched
        let _: isize = unsafe { msg_send![&*pb, clearContents] };
        assert!(mac::set_string(&pb, "public.html", &d.html));
        let mut d2 = data();
        d2.rtf = "{\\rtf1\\ansi second\\par}".into();
        assert!(mac::write_to(&pb, &d2, Duration::from_millis(30)));
        assert!(
            mac::string_for(&pb, "public.rtf")
                .unwrap()
                .contains("second")
        );
        let wa = mac::data_bytes(&pb, "com.apple.webarchive").unwrap();
        assert!(wa.starts_with(b"bplist00"));
        let rtfd = mac::data_bytes(&pb, "public.rtfd").unwrap();
        assert!(rtfd.starts_with(b"rtfd") && rtfd.windows(7).any(|w| w == b"TXT.rtf"));
        assert_eq!(
            mac::string_for(&pb, "public.html").as_deref(),
            Some(d.html.as_str())
        );
        let _: () = unsafe { msg_send![&*pb, releaseGlobally] };
    }

    /// #116: clipboard_write_payload overwrites every flavour.
    #[cfg(target_os = "macos")]
    #[test]
    fn writes_payload_on_private_pasteboard() {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        let pb: Retained<AnyObject> =
            unsafe { msg_send![class!(NSPasteboard), pasteboardWithUniqueName] };
        let d = NativeClipboardData {
            plain: "md".into(),
            html: Some("<p>md</p>".into()),
            markdown: Some("md".into()),
            rtf: Some("{\\rtf1\\ansi md\\par}".into()),
            base_url: "untitled.md".into(),
        };
        assert!(mac::write_payload_to(&pb, &d));
        assert_eq!(mac::string_for(&pb, "public.utf8-plain-text").as_deref(), Some("md"));
        assert_eq!(mac::string_for(&pb, "public.html").as_deref(), Some("<p>md</p>"));
        assert_eq!(mac::string_for(&pb, "net.daringfireball.markdown").as_deref(), Some("md"));
        let rtfd = mac::data_bytes(&pb, "public.rtfd").unwrap(); assert!(rtfd.starts_with(b"rtfd") && rtfd.windows(7).any(|w| w == b"TXT.rtf"));
        assert!(mac::data_bytes(&pb, "com.apple.webarchive").unwrap().starts_with(b"bplist00"));
        let _: () = unsafe { msg_send![&*pb, releaseGlobally] };
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn noop_off_macos() {
        let r = tauri::async_runtime::block_on(clipboard_write_rich(data()));
        assert_eq!(r, Ok(false));
        let p = tauri::async_runtime::block_on(clipboard_write_payload(NativeClipboardData {
            plain: "x".into(),
            ..Default::default()
        }));
        assert_eq!(p, Ok(false));
    }
}
