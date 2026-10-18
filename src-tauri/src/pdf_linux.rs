//! Linux PDF export through WebKitGTK's own printing pipeline (#14).
//!
//! The HTML is loaded into a *hidden* Tauri window (no capability → no IPC,
//! navigations other than the initial load blocked) with a `file://` base URL
//! under the document's folder, so relative images resolve directly (WebKitGTK
//! allows file→file subresource loads). Then `WebKitPrintOperation` runs
//! *without a dialog*, with `GtkPrintSettings` pointing at the output file:
//! GTK's print-to-file backend writes a real multi-page PDF that honours
//! `@media print` and `page-break-*`.
//!
//! Not supported by WebKitGTK's print pipeline: header/footer templates,
//! bookmarks and PDF metadata (the JS fallback for those is unaffected; see
//! the parity ledger). Paper size and margins are applied natively.

use gtk::prelude::*;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PRINT_TIMEOUT: Duration = Duration::from_secs(60);

/// `file:///Users/me/docs/` — percent-encoded, trailing slash so relative
/// URLs resolve inside the folder.
pub fn file_base_url(dir: &Path) -> String {
    /// Percent-encode what a file URL can't hold raw; keep `/` and unreserved.
    const SET: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'`')
        .add(b'{')
        .add(b'}');
    let mut s = String::from("file://");
    s.push_str(
        &percent_encoding::utf8_percent_encode(&dir.to_string_lossy(), SET).to_string(),
    );
    s.push('/');
    s
}

/// Run `f` on the GTK main thread with the platform webview; blocks for its result.
fn on_main<T: Send + 'static>(
    win: &WebviewWindow<impl Runtime>,
    f: impl FnOnce(&webkit2gtk::WebView) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    win.with_webview(move |pw| {
        let _ = tx.send(f(&pw.inner()));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "webview main-thread task dropped".into())
}

/// `file:///path/to/out.pdf` (no trailing slash) for the print output URI.
pub fn file_url(p: &Path) -> String {
    let mut s = file_base_url(p);
    s.pop();
    s
}

/// A4 by default (Typora's default export paper), custom sizes in points.
fn page_setup(paper: Option<&crate::export_cmds::Paper>) -> gtk::PageSetup {
    let setup = gtk::PageSetup::new();
    let (w, h) = paper.map(|p| (p.width, p.height)).unwrap_or((595.0, 842.0));
    let size = gtk::PaperSize::custom("margin-export", "Margin export", w, h, gtk::Unit::Points);
    setup.set_paper_size(&size);
    let m = paper.map(|p| p.margins.clone()).unwrap_or_default();
    setup.set_top_margin(m.top, gtk::Unit::Points);
    setup.set_bottom_margin(m.bottom, gtk::Unit::Points);
    setup.set_left_margin(m.left, gtk::Unit::Points);
    setup.set_right_margin(m.right, gtk::Unit::Points);
    setup
}

pub async fn export_pdf<R: Runtime>(
    app: &AppHandle<R>,
    html: String,
    base_dir: std::path::PathBuf,
    out: std::path::PathBuf,
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

    let result = run(&win, html, file_base_url(&base_dir), &out, options.checked_paper()).await;
    let _ = win.destroy();
    result
}

async fn run(
    win: &WebviewWindow<impl Runtime>,
    html: String,
    base: String,
    out: &Path,
    paper: Option<crate::export_cmds::Paper>,
) -> Result<(), String> {
    on_main(win, move |w| w.load_html(&html, Some(&base)))?;

    // Wait for the load (incl. images) to finish.
    let start = Instant::now();
    tokio_sleep(Duration::from_millis(100)).await;
    loop {
        let loading = on_main(win, |w| w.is_loading())?;
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

    let _ = std::fs::remove_file(out);
    print_op(win, &file_url(out), paper.as_ref())?;
    if out.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        Ok(())
    } else {
        Err("WebKitGTK produced an empty PDF".into())
    }
}

/// Configure and run the print operation; resolves when GTK reports
/// finished/failed. `op.print()` is driven by the GTK main loop, so this only
/// sets it up on the main thread and polls the completion channel off it.
fn print_op(
    win: &WebviewWindow<impl Runtime>,
    out_uri: &str,
    paper: Option<&crate::export_cmds::Paper>,
) -> Result<(), String> {
    let out_uri = out_uri.to_string();
    let done = on_main(win, move |w| {
        let settings = gtk::PrintSettings::new();
        // output-uri makes GTK use its print-to-file (PDF) backend, no dialog.
        settings.set_printer("Print to File");
        settings.set("output-uri", Some(&out_uri));
        settings.set("output-file-format", Some("pdf"));

        let op = webkit2gtk::PrintOperation::new(w);
        op.set_print_settings(&settings);
        op.set_page_setup(&page_setup(paper));

        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        op.connect_failed(move |_, e| {
            let _ = tx.send(Err(e.to_string()));
        });
        let tx2 = tx.clone();
        op.connect_finished(move |_| {
            let _ = tx2.send(Ok(()));
        });
        op.print();
        rx
    })?;
    let deadline = Instant::now() + PRINT_TIMEOUT;
    loop {
        match done.recv_timeout(Duration::from_millis(200)) {
            Ok(r) => return r,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() > deadline {
                    return Err("timed out waiting for WebKitPrintOperation".into());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("print operation vanished".into());
            }
        }
    }
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

#[cfg(test)]
mod tests {
    use super::file_base_url;

    #[test]
    fn base_url_encodes_and_keeps_slashes() {
        assert_eq!(file_base_url(std::path::Path::new("/tmp")), "file:///tmp/");
        assert_eq!(
            file_base_url(std::path::Path::new("/home/me/My Notes")),
            "file:///home/me/My%20Notes/"
        );
    }
}
