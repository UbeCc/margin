//! Pandoc export (docx / latex / epub) — #81.
//!
//! Design rules (learned from Typora's failure modes):
//! - argv only, never a shell string; markdown goes in through stdin.
//! - GUI apps don't inherit the login-shell PATH, so after the configured path and
//!   `$PATH` we also look in the usual Homebrew / user locations.
//! - Every path ends in `Ok` or an `Err(message)`: not-found, not-executable,
//!   too-old, non-zero exit (stderr surfaced) and timeout (process killed).

use serde::Serialize;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
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

/// Run `bin args…` with optional stdin, cwd and a hard timeout (the child is killed on expiry).
pub fn run(bin: &Path, args: &[String], input: Option<String>, cwd: Option<&Path>, timeout: Duration) -> Result<RunOutput, String> {
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

pub struct ExportRequest<'a> {
    pub markdown: String,
    pub out: &'a Path,
    pub format: &'a str,
    /// Directory relative images resolve against (document dir; else the output's dir).
    pub doc_dir: Option<&'a Path>,
    pub title: Option<&'a str>,
    pub timeout: Duration,
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
    Ok(a)
}

/// Run the export. Ok(warnings) — pandoc's stderr on success (may be empty).
pub fn export(bin: &Path, req: ExportRequest) -> Result<String, String> {
    if !req.out.is_absolute() {
        return Err(format!("output path must be absolute: {}", req.out.display()));
    }
    let args = export_args(&req)?;
    let cwd = req.doc_dir.filter(|d| d.is_dir()).or_else(|| req.out.parent().filter(|d| d.is_dir()));
    let out = run(bin, &args, Some(req.markdown), cwd, req.timeout)?;
    if !out.status.success() {
        let detail = excerpt(&out.stderr);
        return Err(if detail.is_empty() { format!("Pandoc failed ({})", out.status) } else { format!("Pandoc failed ({}):\n{detail}", out.status) });
    }
    if !req.out.exists() {
        return Err(format!("Pandoc exited successfully but did not create {}", req.out.display()));
    }
    Ok(excerpt(&out.stderr))
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
) -> R<String> {
    let own = state.own_writes.clone();
    blocking(move || {
        let info = detect(pandoc_path.as_deref(), std::env::var_os("PATH").as_deref(), &fallback_dirs(), VERSION_TIMEOUT)?;
        let out = PathBuf::from(&out_path);
        let existed = out.exists();
        let doc = doc_dir.map(PathBuf::from).filter(|d| d.is_absolute());
        let timeout = timeout_ms.map(Duration::from_millis).unwrap_or(DEFAULT_TIMEOUT).clamp(Duration::from_secs(1), Duration::from_secs(1800));
        let req = ExportRequest { markdown, out: &out, format: &format, doc_dir: doc.as_deref(), title: title.as_deref(), timeout };
        let warnings = export(Path::new(&info.path), req)?;
        own.record(&out, existed);
        Ok(warnings)
    })
    .await
}

#[cfg(test)]
#[path = "pandoc_tests.rs"]
mod tests;
