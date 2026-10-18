//! Windows PDF export through WebView2's own `PrintToPdf` (#14).
//!
//! The HTML is written to a dotfile next to the document (so relative images
//! resolve like on the other platforms — `NavigateToString` has no base URL and
//! caps at 2 MB) and loaded into a *hidden* Tauri window (no capability → no
//! IPC, navigations other than the initial load blocked). When the navigation
//! completes, `ICoreWebView2_7::PrintToPdf` writes a real multi-page PDF that
//! honours `@media print` and `page-break-*`, printing backgrounds, with the
//! paper size and margins from the export options (points → inches). All COM
//! work runs on the UI thread inside `with_webview`, blocking with WebView2's
//! message pump (`webview2_com::wait_with_pump`) while handlers fire.
//!
//! Not supported by WebView2's print-to-PDF: header/footer templates (only a
//! fixed title/URI header+footer exist), bookmarks, metadata. The JS fallback
//! for those is unaffected; see the parity ledger.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment6, ICoreWebView2NavigationCompletedEventArgs,
    ICoreWebView2PrintSettings, ICoreWebView2_7,
};
use webview2_com::{NavigationCompletedEventHandler, PrintToPdfCompletedHandler};
use windows::core::{HSTRING, Interface, PCWSTR};

/// Overall cap for the with_webview call (load + print), enforced off-thread.
const ALL_TIMEOUT: Duration = Duration::from_secs(120);
const PT_PER_INCH: f64 = 72.0;

/// `file:///C:/Users/me/doc.html` for `Navigate`.
pub fn file_url(p: &Path) -> String {
    let mut s = String::from("file:///");
    s.push_str(&p.to_string_lossy().replace('\\', "/"));
    s
}

/// Wait for `rx` (bounded), mapping disconnect to an error.
fn await_result<T>(rx: &mpsc::Receiver<T>, timeout: Duration, what: &str) -> Result<T, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(v) => return Ok(v),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() > deadline {
                    return Err(format!("timed out waiting for {what}"));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("{what} handler vanished"));
            }
        }
    }
}

/// Paper size/margins (points) and background printing.
fn configure(
    settings: &ICoreWebView2PrintSettings,
    paper: Option<&crate::export_cmds::Paper>,
) -> windows::core::Result<()> {
    let (w, h) = paper.map(|p| (p.width, p.height)).unwrap_or((595.0, 842.0)); // A4 default
    unsafe {
        settings.SetPageWidth(w / PT_PER_INCH)?;
        settings.SetPageHeight(h / PT_PER_INCH)?;
        let m = paper.map(|p| p.margins.clone()).unwrap_or_default();
        settings.SetMarginTop(m.top / PT_PER_INCH)?;
        settings.SetMarginBottom(m.bottom / PT_PER_INCH)?;
        settings.SetMarginLeft(m.left / PT_PER_INCH)?;
        settings.SetMarginRight(m.right / PT_PER_INCH)?;
        settings.SetShouldPrintBackgrounds(true)?;
    }
    Ok(())
}

pub async fn export_pdf<R: Runtime>(
    app: &AppHandle<R>,
    html: String,
    base_dir: PathBuf,
    out: PathBuf,
    options: crate::export_cmds::PdfOptions,
) -> Result<(), String> {
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let label = format!(
        "pdf-export-{}",
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().unwrap()))
        .title("Margin PDF export")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(794.0, 1123.0)
        // The exported document may contain raw HTML: never let it navigate away.
        .on_navigation(|url| matches!(url.scheme(), "about" | "file" | "asset"))
        .build()
        .map_err(|e| e.to_string())?;

    // A hidden dotfile next to the document: relative images/CSS resolve like
    // with the other platforms' base-URL loading. Deleted after printing.
    let tmp = base_dir.join(format!(".margin-export-{}.html", std::process::id()));
    std::fs::write(&tmp, &html).map_err(|e| format!("writing export HTML: {e}"))?;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let tmp2 = tmp.clone();
    let out2 = out.clone();
    let paper = options.checked_paper();
    let dispatched = win.with_webview(move |pw| {
        let res = (|| -> Result<(), String> {
            let webview = unsafe { pw.controller().CoreWebView2() }.map_err(|e| format!("CoreWebView2: {e}"))?;
            let wv7: ICoreWebView2_7 = webview
                .cast()
                .map_err(|_| "WebView2 runtime too old for PrintToPdf (needs 1.0.1108+)".to_string())?;
            let env6: ICoreWebView2Environment6 = pw
                .environment()
                .cast()
                .map_err(|_| "WebView2 runtime too old for print settings".to_string())?;

            // Phase 1: navigate to the export HTML, wait (pumping) for completion.
            let (nav_tx, nav_rx) = mpsc::channel::<bool>();
            let handler = NavigationCompletedEventHandler::create(Box::new(
                move |_sender, args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
                    let ok = args
                        .as_ref()
                        .map(|a| {
                            let mut b = windows::core::BOOL::default();
                            unsafe { a.IsSuccess(&mut b) }.is_ok() && b.as_bool()
                        })
                        .unwrap_or(false);
                    let _ = nav_tx.send(ok);
                    Ok(())
                },
            ));
            let mut token = 0i64;
            unsafe {
                webview
                    .add_NavigationCompleted(&handler, &mut token)
                    .map_err(|e| format!("NavigationCompleted: {e}"))?;
                let url = file_url(&tmp2);
                webview
                    .Navigate(&HSTRING::from(url.as_str()))
                    .map_err(|e| format!("Navigate: {e}"))?;
            }
            let nav_ok = webview2_com::wait_with_pump(nav_rx).map_err(|e| format!("load: {e}"))?;
            if !nav_ok {
                return Err("export HTML failed to load".into());
            }
            // Let fonts/layout settle while still pumping messages.
            let (stx, srx) = mpsc::channel::<()>();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                let _ = stx.send(());
            });
            let _ = webview2_com::wait_with_pump(srx);

            // Phase 2: print to the output file.
            let _ = std::fs::remove_file(&out2);
            let settings =
                unsafe { env6.CreatePrintSettings() }.map_err(|e| format!("CreatePrintSettings: {e}"))?;
            configure(&settings, paper.as_ref()).map_err(|e| format!("print settings: {e}"))?;
            let printed = std::sync::Arc::new(AtomicBool::new(false));
            let printed_done = printed.clone();
            let out_h = HSTRING::from(out2.to_string_lossy().as_ref());
            PrintToPdfCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| {
                    unsafe {
                        wv7.PrintToPdf(PCWSTR(out_h.as_ptr()), &settings, &handler)
                            .map_err(webview2_com::Error::WindowsError)
                    }
                }),
                Box::new(move |res: windows::core::Result<()>, ok: bool| {
                    printed_done.store(res.is_ok() && ok, Ordering::Relaxed);
                    Ok(())
                }),
            )
            .map_err(|e| format!("PrintToPdf: {e}"))?;
            if !printed.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("PrintToPdf reported failure".into());
            }
            Ok(())

        })();
        let _ = tx.send(res);
    });
    let res = match dispatched {
        Ok(()) => await_result(&rx, ALL_TIMEOUT, "WebView2 PDF export").unwrap_or_else(|e| Err(e)),
        Err(e) => Err(e.to_string()),
    };
    let _ = std::fs::remove_file(&tmp);
    let _ = win.destroy();
    res?;
    if out.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        Ok(())
    } else {
        Err("WebView2 produced an empty PDF".into())
    }
}

#[cfg(test)]
mod tests {
    use super::file_url;

    #[test]
    fn file_url_format() {
        assert_eq!(file_url(Path::new("/tmp/a.md")), "file:///tmp/a.md");
        assert_eq!(
            file_url(Path::new("C:\\Users\\me\\a b.md")),
            "file:///C:/Users/me/a b.md"
        );
    }
}
