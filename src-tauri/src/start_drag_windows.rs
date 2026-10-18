//! Windows/WebView2: sidebar files dragged out of the window / over our own editor (#129).
//!
//! `SHCreateDataObject` builds a shell data object; we add `CF_HDROP` (the paths),
//! the private `application/x-margin-path` format and `CF_UNICODETEXT` (the first
//! path) so that (a) Explorer accepts the drop, (b) our own `drop_windows` hook
//! recognises the drag as internal and forwards it to WebView2 untouched, and
//! (c) the page can read the path as plain text. `SHDoDragDrop` runs its own modal
//! loop — it must not block the UI thread, so it runs on a dedicated thread with
//! OLE initialized.

use windows::core::{implement, BOOL, Interface};
use windows::Win32::Foundation::{
    DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HRESULT,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, FORMATETC, IDataObject, STGMEDIUM, TYMED_HGLOBAL,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{
    IDropSource, IDropSource_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{SHCreateDataObject, SHDoDragDrop};

const CF_HDROP: u16 = 15;
const CF_UNICODETEXT: u16 = 13;
const MK_LBUTTON: MODIFIERKEYS_FLAGS = MODIFIERKEYS_FLAGS(0x1);

/// `STGMEDIUM` with an owned HGLOBAL of `bytes` (caller hands it to SetData).
unsafe fn hglobal(bytes: &[u8]) -> windows::core::Result<STGMEDIUM> {
    let h = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }?;
    let dst = unsafe { GlobalLock(h) } as *mut u8;
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
        let _ = GlobalUnlock(h);
    }
    Ok(STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: windows::Win32::System::Com::union_STGMEDIUM_0 { hGlobal: h },
        pUnkForRelease: None,
    })
}

/// Paths as a `CF_HDROP` blob (double-NUL-terminated wide strings).
fn hdrop_bytes(paths: &[String]) -> Vec<u8> {
    let mut wide: Vec<u16> = Vec::new();
    for p in paths {
        wide.extend(p.encode_utf16());
        wide.push(0);
    }
    wide.push(0);
    wide.iter().flat_map(|u| u.to_le_bytes()).collect()
}

fn wide_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(|u| u.to_le_bytes())
        .collect()
}

unsafe fn set_hglobal(data: &IDataObject, format: u16, bytes: &[u8]) -> windows::core::Result<()> {
    let etc = FORMATETC {
        cfFormat: format,
        ptd: std::ptr::null_mut(),
        dwAspect: 1, // DVASPECT_CONTENT
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let medium = unsafe { hglobal(bytes) }?;
    unsafe { data.SetData(&etc, &medium, true) }.ok()
}

unsafe fn build_data_object(paths: &[String]) -> windows::core::Result<IDataObject> {
    let data: IDataObject = unsafe { SHCreateDataObject(None, None, None)? };
    unsafe {
        set_hglobal(&data, CF_HDROP, &hdrop_bytes(paths))?;
        let private = windows::Win32::System::DataExchange::RegisterClipboardFormatW(windows::core::w!(
            "application/x-margin-path"
        ));
        if private != 0 {
            set_hglobal(&data, private as u16, &wide_bytes(&paths[0]))?;
        }
        set_hglobal(&data, CF_UNICODETEXT, &wide_bytes(&paths[0]))?;
    }
    Ok(data)
}

#[implement(IDropSource)]
struct DragSource;

#[allow(non_snake_case)]
impl IDropSource_Impl for DragSource_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if !keys.contains(MK_LBUTTON) {
            return DRAGDROP_S_DROP; // button released
        }
        HRESULT(0)
    }
    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// Start a native drag of `paths`; returns immediately (the modal loop runs on
/// its own thread until the mouse is released).
pub fn start_drag(paths: &[String]) -> bool {
    if paths.is_empty() {
        return false;
    }
    let paths: Vec<String> = paths.to_vec();
    std::thread::spawn(move || unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return;
        }
        struct Uninit;
        impl Drop for Uninit {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let _uninit = Uninit;
        let Ok(data) = build_data_object(&paths) else { return };
        let source: IDropSource = DragSource.into();
        // SHDoDragDrop renders the drag image and shows standard cursors.
        let _ = SHDoDragDrop(None, &data, &source, DROPEFFECT_COPY | DROPEFFECT_MOVE);
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hdrop_blob_is_double_nul_terminated() {
        let b = hdrop_bytes(&["C:\\a b.md".into()]);
        let wide: Vec<u16> = b.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(wide.last(), Some(&0));
        assert!(wide.windows(2).any(|w| w == [0, 0]));
        let text: String = String::from_utf16_lossy(&wide[..wide.len() - 2]);
        assert_eq!(text, "C:\\a b.md");
    }

    #[test]
    fn wide_blob_is_nul_terminated() {
        let b = wide_bytes("a");
        assert_eq!(b, vec![b'a', 0, 0, 0]);
    }
}
