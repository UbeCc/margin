//! Pandoc export (docx / latex / epub) — #81.
//!
//! Design rules (learned from Typora's failure modes):
//! - argv only, never a shell string; markdown goes in through stdin.
//! - GUI apps don't inherit the login-shell PATH, so after the configured path and
//!   `$PATH` we also look in the usual Homebrew / user locations.
//! - Every path ends in `Ok` or an `Err(message)`: not-found, not-executable,
//!   too-old, non-zero exit (stderr surfaced) and timeout (process killed).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest stderr excerpt put into an error message.
const MAX_STDERR: usize = 4000;

#[cfg(windows)]
const EXE: &str = "pandoc.exe";
#[cfg(not(windows))]
const EXE: &str = "pandoc";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PandocInfo {
    pub path: String,
    pub version: String,
}

/// Output formats we offer: (id, pandoc writer, extra args).
pub fn writer_for(format: &str) -> Option<(&'static str, &'static [&'static str])> {
    match format {
        "docx" => Some(("docx", &[])),
        "latex" => Some(("latex", &["--standalone"])),
        "epub" => Some(("epub", &[])),
        // #95: the rest of the classic export list.
        "odt" => Some(("odt", &[])),
        "rtf" => Some(("rtf", &["--standalone"])),
        "mediawiki" => Some(("mediawiki", &[])),
        "rst" => Some(("rst", &["--standalone"])),
        "textile" => Some(("textile", &[])),
        "opml" => Some(("opml", &["--standalone"])),
        _ => None,
    }
}

/// Directories GUI apps miss because they don't run a login shell.
pub fn fallback_dirs() -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        v.push(home.join(".local/bin"));
        v.push(home.join(".cabal/bin"));
        v.push(home.join(".ghcup/bin"));
    }
    v
}

/// Find the pandoc binary: configured path (file or directory) → `$PATH` → fallbacks.
pub fn resolve(configured: Option<&str>, path_env: Option<&OsStr>, fallbacks: &[PathBuf]) -> Result<PathBuf, String> {
    if let Some(c) = configured.map(str::trim).filter(|c| !c.is_empty()) {
        let mut p = PathBuf::from(c);
        if let (Some(rest), Some(home)) = (c.strip_prefix("~/"), std::env::var_os("HOME")) {
            p = PathBuf::from(home).join(rest);
        }
        if p.is_dir() {
            p = p.join(EXE);
        }
        if !p.is_file() {
            return Err(format!("Pandoc not found at {} (check Preferences › Files › Pandoc path)", p.display()));
        }
        return Ok(p);
    }
    let from_env = path_env.map(|e| std::env::split_paths(e).collect::<Vec<_>>()).unwrap_or_default();
    from_env
        .iter()
        .chain(fallbacks)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(EXE))
        .find(|p| p.is_file())
        .ok_or_else(|| {
            "Pandoc not found. Install it (https://pandoc.org/installing.html, e.g. `brew install pandoc`) or set its path in Preferences › Files.".to_string()
        })
}

/// Parse `pandoc 3.1.2` (first line of `--version`) → "3.1.2".
pub fn parse_version(out: &str) -> Option<String> {
    let line = out.lines().next()?;
    line.split_whitespace().find_map(|tok| {
        let v: String = tok.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let v = v.trim_end_matches('.');
        (v.starts_with(|c: char| c.is_ascii_digit()) && tok.starts_with(|c: char| c.is_ascii_digit())).then(|| v.to_string())
    })
}

fn major(v: &str) -> u32 {
    v.split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0)
}

#[cfg(unix)]
fn check_executable(p: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(p).map_err(|e| format!("Cannot read {}: {e}", p.display()))?.permissions().mode();
    if mode & 0o111 == 0 {
        return Err(format!("Pandoc at {} is not executable (chmod +x it or pick another path)", p.display()));
    }
    Ok(())
}
#[cfg(not(unix))]
fn check_executable(_p: &Path) -> Result<(), String> {
    Ok(())
}

pub struct RunOutput {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

fn reader(mut r: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    rx
}

/// Pipes may be held open by grandchildren after the child exits; never wait forever on them.
fn collect(rx: &mpsc::Receiver<Vec<u8>>) -> String {
    rx.recv_timeout(Duration::from_secs(2)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

/// Error message of an export stopped with the Abort button (#90). The UI matches it
/// exactly and shows no error dialog (Typora: an aborted export reports nothing).
pub const ABORTED: &str = "Export aborted";

/// Run `bin args…` with optional stdin, cwd and a hard timeout (the child is killed on expiry).
pub fn run(bin: &Path, args: &[String], input: Option<String>, cwd: Option<&Path>, timeout: Duration) -> Result<RunOutput, String> {
    run_cancellable(bin, args, input, cwd, timeout, None)
}

/// [`run`] that also kills the child as soon as `cancel` is set → `Err(ABORTED)`.
pub fn run_cancellable(
    bin: &Path,
    args: &[String],
    input: Option<String>,
    cwd: Option<&Path>,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<RunOutput, String> {
    if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
        return Err(ABORTED.into());
    }
    check_executable(bin)?;
    let mut cmd = Command::new(bin);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    // ETXTBSY: a just-written executable can still have a writable fd open in a child
    // that another thread forked but hasn't exec'd yet (fd inherited until CLOEXEC fires).
    // It clears within milliseconds, so retry briefly instead of failing the export.
    let mut spawned = cmd.spawn();
    for _ in 0..20 {
        match &spawned {
            Err(e) if e.raw_os_error() == Some(26) => {
                std::thread::sleep(Duration::from_millis(25));
                spawned = cmd.spawn();
            }
            _ => break,
        }
    }
    let mut child = spawned.map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => format!("Pandoc at {} is not executable: {e}", bin.display()),
        std::io::ErrorKind::NotFound => format!("Cannot run {}: {e}", bin.display()),
        _ => format!("Failed to start {}: {e}", bin.display()),
    })?;
    // Write stdin on its own thread: a large document would otherwise fill the pipe
    // while pandoc blocks writing stderr → deadlock. Broken pipe (early exit) is fine.
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let out_rx = reader(child.stdout.take().expect("piped stdout"));
    let err_rx = reader(child.stderr.take().expect("piped stderr"));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ABORTED.into());
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let stderr = collect(&err_rx);
                let mut msg = format!("Pandoc timed out after {}s and was stopped", timeout.as_secs_f32().round());
                if !stderr.trim().is_empty() {
                    msg.push_str(&format!(":\n{}", excerpt(&stderr)));
                }
                return Err(msg);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(e) => {
                let _ = child.kill();
                return Err(format!("Lost track of pandoc: {e}"));
            }
        }
    };
    Ok(RunOutput { status, stdout: collect(&out_rx), stderr: collect(&err_rx) })
}

fn excerpt(s: &str) -> String {
    let t = s.trim();
    if t.len() <= MAX_STDERR {
        return t.to_string();
    }
    let mut cut = MAX_STDERR;
    while !t.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &t[..cut])
}

/// Locate pandoc and check `--version` ≥ 2.
pub fn detect(configured: Option<&str>, path_env: Option<&OsStr>, fallbacks: &[PathBuf], timeout: Duration) -> Result<PandocInfo, String> {
    let bin = resolve(configured, path_env, fallbacks)?;
    let out = run(&bin, &["--version".into()], None, None, timeout)?;
    if !out.status.success() {
        return Err(format!("`{} --version` failed ({}): {}", bin.display(), out.status, excerpt(&out.stderr)));
    }
    let version = parse_version(&out.stdout)
        .ok_or_else(|| format!("{} doesn't look like pandoc (unrecognised --version output)", bin.display()))?;
    if major(&version) < 2 {
        return Err(format!("Pandoc {version} at {} is too old; Margin needs pandoc 2.0 or newer", bin.display()));
    }
    Ok(PandocInfo { path: bin.to_string_lossy().into_owned(), version })
}

/// Per-format Pandoc options (Preferences › Export, #90). Empty strings = unset.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PandocOptions {
    /// `--pdf-engine=<v>` (PDF via LaTeX only).
    pub pdf_engine: String,
    /// `--css <v>` (epub).
    pub css: String,
    /// `--reference-doc <v>` (docx / odt).
    pub reference_doc: String,
    /// `--template <v>`.
    pub template: String,
    /// `--epub-chapter-level=<n>` (epub; 0 = unset).
    pub epub_chapter_level: u32,
    /// `--toc`.
    pub toc: bool,
    /// Extra arguments as typed: POSIX-style quoting, `${outputPath}` etc. expanded per token.
    pub extra_arguments: String,
}

pub struct ExportRequest<'a> {
    pub markdown: String,
    pub out: &'a Path,
    pub format: &'a str,
    /// Directory relative images resolve against (document dir; else the output's dir).
    pub doc_dir: Option<&'a Path>,
    pub title: Option<&'a str>,
    pub timeout: Duration,
    pub options: PandocOptions,
    /// Set by the Abort button ([`pandoc_abort`]).
    pub cancel: Option<Arc<AtomicBool>>,
}

/// Variables available in extra arguments (Typora's `processExportVariables` subset).
pub fn arg_vars(out: &Path, doc_dir: Option<&Path>, title: Option<&str>) -> HashMap<String, String> {
    let mut v = HashMap::new();
    v.insert("outputPath".into(), out.to_string_lossy().into_owned());
    let folder = out.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    v.insert("outputFolder".into(), folder);
    if let Some(stem) = out.file_stem() {
        v.insert("outputFileName".into(), stem.to_string_lossy().into_owned());
    }
    if let Some(d) = doc_dir {
        v.insert("currentFolder".into(), d.to_string_lossy().into_owned());
    }
    if let Some(t) = title {
        v.insert("title".into(), t.to_string());
    }
    v
}

/// Option argv in Typora's order: pdf-engine, css, reference-doc, template,
/// epub-chapter-level, toc, then the extra arguments.
pub fn option_args(o: &PandocOptions, vars: &HashMap<String, String>) -> Result<Vec<String>, String> {
    let mut a = Vec::new();
    let t = |s: &str| s.trim().to_string();
    if !o.pdf_engine.trim().is_empty() {
        a.push(format!("--pdf-engine={}", t(&o.pdf_engine)));
    }
    for (flag, v) in [("--css", &o.css), ("--reference-doc", &o.reference_doc), ("--template", &o.template)] {
        if !v.trim().is_empty() {
            a.push(flag.into());
            a.push(crate::export_custom::expand_token(&t(v), vars));
        }
    }
    if o.epub_chapter_level > 0 {
        a.push(format!("--epub-chapter-level={}", o.epub_chapter_level.min(6)));
    }
    if o.toc {
        a.push("--toc".into());
    }
    if !o.extra_arguments.trim().is_empty() {
        let toks = crate::upload::split_command(&o.extra_arguments).map_err(|e| format!("Extra arguments: {}", e.replace("upload command", "argument list")))?;
        a.extend(toks.iter().map(|tok| crate::export_custom::expand_token(tok, vars)));
    }
    Ok(a)
}

/// argv for one export (without the binary).
pub fn export_args(req: &ExportRequest) -> Result<Vec<String>, String> {
    let (writer, extra) = writer_for(req.format).ok_or_else(|| format!("Unsupported export format: {}", req.format))?;
    let res_dir = req.doc_dir.or_else(|| req.out.parent()).unwrap_or(Path::new("."));
    let mut a: Vec<String> = vec!["-f".into(), "markdown".into(), "-t".into(), writer.into()];
    a.extend(extra.iter().map(|s| s.to_string()));
    a.push("-o".into());
    a.push(req.out.to_string_lossy().into_owned());
    a.push("--resource-path".into());
    a.push(res_dir.to_string_lossy().into_owned());
    if let Some(t) = req.title.map(str::trim).filter(|t| !t.is_empty()) {
        // `pagetitle` is only a fallback: a front-matter `title` still wins.
        a.push(format!("--metadata=pagetitle:{t}"));
    }
    a.extend(option_args(&req.options, &arg_vars(req.out, req.doc_dir, req.title))?);
    Ok(a)
}

/// Run the export. Ok(warnings) — pandoc's stderr on success (may be empty).
pub fn export(bin: &Path, req: ExportRequest) -> Result<String, String> {
    if !req.out.is_absolute() {
        return Err(format!("output path must be absolute: {}", req.out.display()));
    }
    let args = export_args(&req)?;
    let cwd = req.doc_dir.filter(|d| d.is_dir()).or_else(|| req.out.parent().filter(|d| d.is_dir()));
    let out = run_cancellable(bin, &args, Some(req.markdown), cwd, req.timeout, req.cancel.as_deref())?;
    if !out.status.success() {
        let detail = excerpt(&out.stderr);
        return Err(if detail.is_empty() { format!("Pandoc failed ({})", out.status) } else { format!("Pandoc failed ({}):\n{detail}", out.status) });
    }
    if !req.out.exists() {
        return Err(format!("Pandoc exited successfully but did not create {}", req.out.display()));
    }
    Ok(excerpt(&out.stderr))
}

/// Running exports by UI-chosen id, for the Abort button.
fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

/// Register an export id; the returned flag is set by [`abort`].
pub fn register(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    running().lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), flag.clone());
    flag
}

pub fn unregister(id: &str) {
    running().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

/// Abort a running export. false if it already finished (or never started).
pub fn abort(id: &str) -> bool {
    match running().lock().unwrap_or_else(|e| e.into_inner()).get(id) {
        Some(f) => {
            f.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

// ------------------------------------------------------------------ tauri commands

type R<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("pandoc task failed: {e}"))?
}

/// Locate pandoc and report its version (Preferences › Files › "Detect").
#[tauri::command]
pub async fn pandoc_detect(pandoc_path: Option<String>) -> R<PandocInfo> {
    blocking(move || detect(pandoc_path.as_deref(), std::env::var_os("PATH").as_deref(), &fallback_dirs(), VERSION_TIMEOUT)).await
}

/// Export `markdown` with pandoc. Ok(warnings from pandoc's stderr).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pandoc_export(
    state: tauri::State<'_, crate::AppState>,
    markdown: String,
    out_path: String,
    format: String,
    doc_dir: Option<String>,
    title: Option<String>,
    pandoc_path: Option<String>,
    timeout_ms: Option<u64>,
    options: Option<PandocOptions>,
    export_id: Option<String>,
) -> R<String> {
    let own = state.own_writes.clone();
    let cancel = export_id.as_deref().map(register);
    let id = export_id.clone();
    let res = blocking(move || {
        if cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(ABORTED.to_string());
        }
        let info = detect(pandoc_path.as_deref(), std::env::var_os("PATH").as_deref(), &fallback_dirs(), VERSION_TIMEOUT)?;
        let out = PathBuf::from(&out_path);
        let existed = out.exists();
        let doc = doc_dir.map(PathBuf::from).filter(|d| d.is_absolute());
        let timeout = timeout_ms.map(Duration::from_millis).unwrap_or(DEFAULT_TIMEOUT).clamp(Duration::from_secs(1), Duration::from_secs(1800));
        let options = options.unwrap_or_default();
        let req = ExportRequest { markdown, out: &out, format: &format, doc_dir: doc.as_deref(), title: title.as_deref(), timeout, options, cancel };
        let warnings = export(Path::new(&info.path), req)?;
        own.record(&out, existed);
        Ok(warnings)
    })
    .await;
    if let Some(id) = id {
        unregister(&id);
    }
    res
}

/// Abort button of the "Exporting…" notice (#90). Ok(false) if the export already ended.
#[tauri::command]
pub fn pandoc_abort(export_id: String) -> bool {
    abort(&export_id)
}

#[cfg(test)]
#[path = "pandoc_tests.rs"]
mod tests;
