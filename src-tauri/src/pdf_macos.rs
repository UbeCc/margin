//! macOS PDF export through WebKit's own printing pipeline.
//!
//! The HTML is loaded into a *hidden* Tauri window (no capability → no IPC, all
//! navigations except the initial load blocked) with an `asset://` base URL, so
//! relative and asset-protocol images resolve through the scoped asset protocol
//! rather than giving the page `file://` access. Then:
//!
//! 1. Paginated: `-[WKWebView printOperationWithPrintInfo:]` with job disposition
//!    `NSPrintSaveJob` → writes a real multi-page PDF (honours `@media print`,
//!    `page-break-*`), no panels shown.
//! 2. Fallback: `-[WKWebView createPDFWithConfiguration:completionHandler:]`, which
//!    produces a single tall page.

use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject};
use objc2::{AllocAnyThread, DefinedClass, MainThreadMarker, define_class, msg_send, sel};
use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode, NSWindow};
use objc2_foundation::{NSData, NSError, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_web_kit::WKWebView;
use std::cell::RefCell;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const PAGE_WIDTH_PX: f64 = 794.0; // A4 @ 96dpi
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PRINT_TIMEOUT: Duration = Duration::from_secs(60);

pub struct DelegateIvars {
    tx: Mutex<Option<mpsc::Sender<bool>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct PrintDelegate;

    impl PrintDelegate {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _op: &NSPrintOperation, success: Bool, _ctx: *mut c_void) {
            if let Some(tx) = self.ivars().tx.lock().unwrap().take() {
                let _ = tx.send(success.as_bool());
            }
        }
    }

    unsafe impl NSObjectProtocol for PrintDelegate {}
);

impl PrintDelegate {
    fn new(tx: mpsc::Sender<bool>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { tx: Mutex::new(Some(tx)) });
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    // NSPrintOperation does not retain its delegate; keep ours alive until it fires.
    static LIVE_DELEGATES: RefCell<Vec<Retained<PrintDelegate>>> = const { RefCell::new(Vec::new()) };
}

/// `asset://localhost/%2FUsers/me/docs/` — the first slash is encoded so that the
/// remaining path segments stay real segments and relative URLs resolve inside it.
pub fn asset_base_url(dir: &Path) -> String {
    use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
    const SEG: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
    let s = dir.to_string_lossy();
    let segs: Vec<String> = s
        .trim_start_matches('/')
        .split('/')
        .filter(|x| !x.is_empty())
        .map(|seg| utf8_percent_encode(seg, SEG).to_string())
        .collect();
    let mut url = String::from("asset://localhost/%2F");
    for seg in segs {
        url.push_str(&seg);
        url.push('/');
    }
    url
}

fn on_main<R: Runtime, T: Send + 'static>(
    win: &WebviewWindow<R>,
    f: impl FnOnce(&WKWebView, &NSWindow) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    win.with_webview(move |pw| unsafe {
        let wk = &*(pw.inner() as *const WKWebView);
        let ns_window = &*(pw.ns_window() as *const NSWindow);
        let _ = tx.send(f(wk, ns_window));
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "main thread did not respond".to_string())
}

async fn wait_blocking<T: Send + 'static>(rx: mpsc::Receiver<T>, timeout: Duration) -> Option<T> {
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout).ok())
        .await
        .ok()
        .flatten()
}

pub async fn export_pdf<R: Runtime>(app: &AppHandle<R>, html: String, base_dir: PathBuf, out: PathBuf) -> Result<(), String> {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let label = format!("pdf-export-{}", COUNTER.fetch_add(1, Ordering::Relaxed));
    let base = asset_base_url(&base_dir);
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().unwrap()))
        .title("Margin PDF export")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(PAGE_WIDTH_PX, 1123.0)
        // The exported document may contain raw HTML: never let it navigate away.
        .on_navigation(|url| matches!(url.scheme(), "about" | "asset"))
        .build()
        .map_err(|e| e.to_string())?;

    let result = run(&win, html, base, out.clone()).await;
    let _ = win.destroy();
    result
}

async fn run<R: Runtime>(win: &WebviewWindow<R>, html: String, base: String, out: PathBuf) -> Result<(), String> {
    on_main(win, move |wk, _| unsafe {
        // Print CSS backgrounds (code blocks, tables, themes). macOS 13.3+.
        let prefs = wk.configuration().preferences();
        if prefs.respondsToSelector(sel!(setShouldPrintBackgrounds:)) {
            prefs.setShouldPrintBackgrounds(true);
        }
        let base_url = NSURL::URLWithString(&NSString::from_str(&base));
        wk.loadHTMLString_baseURL(&NSString::from_str(&html), base_url.as_deref());
    })?;

    // Wait for the load (incl. images) to finish.
    let start = Instant::now();
    tokio_sleep(Duration::from_millis(100)).await;
    loop {
        let loading = on_main(win, |wk, _| unsafe { wk.isLoading() })?;
        if !loading {
            break;
        }
        if start.elapsed() > LOAD_TIMEOUT {
            return Err("timed out loading export HTML".into());
        }
        tokio_sleep(Duration::from_millis(100)).await;
    }
    // Let fonts/layout settle.
    tokio_sleep(Duration::from_millis(400)).await;

    let _ = std::fs::remove_file(&out);
    if print_paginated(win, &out).await.is_ok() && file_nonempty(&out) {
        return Ok(());
    }
    log::warn!("paginated PDF export failed; falling back to createPDF (single page)");
    create_pdf_single_page(win, &out).await
}

fn file_nonempty(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false)
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

async fn print_paginated<R: Runtime>(win: &WebviewWindow<R>, out: &Path) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<bool>();
    let out_str = out.to_string_lossy().into_owned();
    on_main(win, move |wk, ns_window| unsafe {
        let mtm = MainThreadMarker::new().expect("main thread");
        let info = NSPrintInfo::new();
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(&out_str));
        let dict = info.dictionary();
        let key: &NSString = objc2_app_kit::NSPrintJobSavingURL;
        let _: () = msg_send![&*dict, setObject: &*url, forKey: key];
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        for set in [NSPrintInfo::setTopMargin, NSPrintInfo::setBottomMargin, NSPrintInfo::setLeftMargin, NSPrintInfo::setRightMargin] {
            set(&info, 36.0);
        }
        let op = wk.printOperationWithPrintInfo(&info);
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);
        op.setJobTitle(Some(&NSString::from_str("Margin export")));
        let paper = info.paperSize();
        if let Some(view) = op.view() {
            // WKWebView prints blank pages unless its print view has a real frame.
            view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(paper.width, paper.height)));
        }
        let delegate = PrintDelegate::new(tx);
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            ns_window,
            Some(&delegate),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
        LIVE_DELEGATES.with(|d| d.borrow_mut().push(delegate));
        let _ = mtm;
    })?;
    let ok = wait_blocking(rx, PRINT_TIMEOUT).await;
    let _ = win.run_on_main_thread(|| LIVE_DELEGATES.with(|d| d.borrow_mut().clear()));
    match ok {
        Some(true) => Ok(()),
        Some(false) => Err("print operation failed".into()),
        None => Err("print operation timed out".into()),
    }
}

async fn create_pdf_single_page<R: Runtime>(win: &WebviewWindow<R>, out: &Path) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    on_main(win, move |wk, _| unsafe {
        let tx = Mutex::new(Some(tx));
        let block = block2::RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
            let res = if !data.is_null() {
                Ok((*data).to_vec())
            } else if !err.is_null() {
                Err((*err).localizedDescription().to_string())
            } else {
                Err("createPDF returned nothing".into())
            };
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(res);
            }
        });
        wk.createPDFWithConfiguration_completionHandler(None, &block);
    })?;
    let bytes = wait_blocking(rx, PRINT_TIMEOUT).await.ok_or("createPDF timed out")??;
    crate::fsops::atomic_write(out, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Used by `set_document_edited`.
pub fn set_document_edited<R: Runtime>(win: &tauri::WebviewWindow<R>, edited: bool) -> Result<(), String> {
    let ptr = win.ns_window().map_err(|e| e.to_string())? as usize;
    win.run_on_main_thread(move || unsafe {
        let w = &*(ptr as *const NSWindow);
        w.setDocumentEdited(edited);
    })
    .map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base_url_encoding() {
        assert_eq!(asset_base_url(Path::new("/Users/me/My Docs")), "asset://localhost/%2FUsers/me/My%20Docs/");
        assert_eq!(asset_base_url(Path::new("/")), "asset://localhost/%2F");
    }
}
