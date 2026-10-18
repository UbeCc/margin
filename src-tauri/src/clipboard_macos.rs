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

#[cfg(target_os = "macos")]
mod mac {
    use super::RichClipboardData;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::{NSData, NSString};
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_millis(400);
    const POLL: Duration = Duration::from_millis(15);

    fn board() -> Option<Retained<AnyObject>> {
        unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
    }

    fn change_count(pb: &AnyObject) -> isize {
        unsafe { msg_send![pb, changeCount] }
    }

    fn string_for(pb: &AnyObject, ty: &str) -> Option<String> {
        let ty = NSString::from_str(ty);
        let s: Option<Retained<NSString>> = unsafe { msg_send![pb, stringForType: &*ty] };
        s.map(|s| s.to_string())
    }

    fn set_string(pb: &AnyObject, ty: &str, value: &str) -> bool {
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

    pub fn write(d: &RichClipboardData) -> bool {
        let Some(pb) = board() else { return false };
        let start = change_count(&pb);
        let deadline = Instant::now() + WAIT;
        loop {
            match string_for(&pb, "public.html") {
                Some(h) if h.contains(&d.marker) => {
                    add_type(&pb, "public.rtf");
                    return set_data(&pb, "public.rtf", d.rtf.as_bytes());
                }
                Some(_) if change_count(&pb) != start => return false, // a newer copy landed
                _ => {}
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(POLL);
        }
        // WebKit's write never showed up; write every flavour ourselves unless the
        // pasteboard moved on meanwhile.
        if change_count(&pb) != start {
            return false;
        }
        let _: isize = unsafe { msg_send![&*pb, clearContents] };
        let mut ok = set_string(&pb, "public.utf8-plain-text", &d.plain);
        ok &= set_string(&pb, "public.html", &d.html);
        ok &= set_data(&pb, "public.rtf", d.rtf.as_bytes());
        ok &= set_string(&pb, "net.daringfireball.markdown", &d.markdown);
        ok
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
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn noop_off_macos() {
        let r = tauri::async_runtime::block_on(clipboard_write_rich(data()));
        assert_eq!(r, Ok(false));
    }
}
