//! Image upload pipeline (#80): a user-configured command or a local PicGo server.
//!
//! Safety rules (deliberately unlike Typora's `bash -c "<cmd> \"<path>\""`):
//! * the custom command string is tokenized once into argv (shell-words rules, no
//!   expansion of any kind) and executed directly with `std::process::Command` —
//!   never through a shell; image paths are appended as separate argv entries, so
//!   `$(...)`, backticks, quotes and spaces in file names are inert;
//! * the child gets a timeout (scaled by image count, capped) and is killed on expiry;
//! * PicGo is only ever contacted on the loopback interface.

use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const DEFAULT_PICGO_PORT: u16 = 36677;

/// Bumped by `cancel_upload`; a running command compares it with its start value.
static CANCEL_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn cancel_gen() -> u64 {
    CANCEL_GEN.load(std::sync::atomic::Ordering::SeqCst)
}

/// Abort every upload command that is running now (it is killed).
pub fn cancel_all() {
    CANCEL_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}
pub const DEFAULT_PER_IMAGE_SECS: u64 = 30;
pub const MAX_TIMEOUT_SECS: u64 = 300;
const OUTPUT_LIMIT: usize = 4 << 20;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UploadConfig {
    /// `command`: e.g. `picgo upload` or `/usr/local/bin/upic -o url -u`.
    Command {
        command: String,
        #[serde(default, rename = "timeoutSecs")]
        timeout_secs: Option<u64>,
    },
    Picgo {
        #[serde(default)]
        port: Option<u16>,
        #[serde(default, rename = "timeoutSecs")]
        timeout_secs: Option<u64>,
    },
}

/// Total budget for a batch: `per_image * n`, clamped to `[per_image, MAX_TIMEOUT_SECS]`.
pub fn batch_timeout(per_image_secs: Option<u64>, n: usize) -> Duration {
    let per = per_image_secs.unwrap_or(DEFAULT_PER_IMAGE_SECS).clamp(1, MAX_TIMEOUT_SECS);
    Duration::from_secs(per.saturating_mul(n.max(1) as u64).min(MAX_TIMEOUT_SECS.max(per)))
}

/// Split a command line into argv like a POSIX shell would *tokenize* it, without
/// performing any expansion: `'single'` is literal, `"double"` honours `\"`, `\\`,
/// `\$`, `` \` `` and line continuations, a bare backslash escapes the next char.
pub fn split_command(s: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            c if c.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            '\'' => {
                in_word = true;
                loop {
                    match it.next() {
                        Some('\'') => break,
                        Some(ch) => cur.push(ch),
                        None => return Err("unterminated single quote in upload command".into()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match it.next() {
                        Some('"') => break,
                        Some('\\') => match it.next() {
                            Some(ch @ ('"' | '\\' | '$' | '`')) => cur.push(ch),
                            Some('\n') => {}
                            Some(ch) => {
                                cur.push('\\');
                                cur.push(ch);
                            }
                            None => return Err("unterminated double quote in upload command".into()),
                        },
                        Some(ch) => cur.push(ch),
                        None => return Err("unterminated double quote in upload command".into()),
                    }
                }
            }
            '\\' => match it.next() {
                Some('\n') => {}
                Some(ch) => {
                    in_word = true;
                    cur.push(ch);
                }
                None => return Err("trailing backslash in upload command".into()),
            },
            ch => {
                in_word = true;
                cur.push(ch);
            }
        }
    }
    if in_word {
        out.push(cur);
    }
    Ok(out)
}

/// One output line as an uploaded-image URL (Typora's rules): `http(s)://`, `ftp://`
/// or `file:/` lines, or a bare `host.tld/path` (which gets `http://` prepended).
pub fn url_of_line(line: &str) -> Option<String> {
    let l = line.trim();
    if l.is_empty() || l.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = l.to_ascii_lowercase();
    for scheme in ["https://", "http://", "ftp://"] {
        if lower.starts_with(scheme) && l.len() > scheme.len() + 1 {
            return Some(l.to_string());
        }
    }
    if lower.starts_with("file:/") && l.len() > "file:/".len() {
        return Some(l.to_string());
    }
    // host.tld/… : at least one dot in the host, then a path
    let (host, rest) = l.split_once('/')?;
    let labels: Vec<&str> = host.split('.').collect();
    let ok = labels.len() >= 2
        && labels.iter().all(|x| !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ':'))
        && labels.last().is_some_and(|tld| tld.split(':').next().is_some_and(|t| t.len() >= 2 && t.chars().all(|c| c.is_ascii_alphabetic())));
    (ok && !rest.is_empty()).then(|| format!("http://{l}"))
}

fn is_url(line: &str) -> bool {
    let l = line.trim();
    (l.starts_with("https://") || l.starts_with("http://"))
        && l.len() > "http://x".len()
        && !l.chars().any(char::is_whitespace)
}

/// All URLs at the tail of an uploader's output: scanning backwards (ignoring blank
/// lines) collects the contiguous run of URL lines and stops at the first other line.
pub fn tail_urls(stdout: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in stdout.lines().rev() {
        if line.trim().is_empty() {
            continue;
        }
        match url_of_line(line) {
            Some(u) => found.push(u),
            None => break,
        }
    }
    found.reverse();
    found
}

/// URLs for `n` uploaded images (Typora): one image takes the last URL; a batch needs
/// exactly one URL per image.
pub fn extract_urls(stdout: &str, n: usize) -> Result<Vec<String>, String> {
    let mut found = tail_urls(stdout);
    if n == 1 && !found.is_empty() {
        return Ok(found.split_off(found.len() - 1));
    }
    if found.len() != n || n == 0 {
        return Err(format!("Failed to fetch uploaded image from command output: {} URL(s) for {} image(s)", found.len(), n));
    }
    Ok(found)
}

/// Every path must be an absolute path to an existing regular file.
pub fn check_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no images to upload".into());
    }
    for p in paths {
        let path = Path::new(p);
        if !path.is_absolute() {
            return Err(format!("image path must be absolute: {p}"));
        }
        if !path.is_file() {
            return Err(format!("image not found: {p}"));
        }
    }
    Ok(())
}

fn tail(s: &str, lines: usize) -> String {
    let v: Vec<&str> = s.trim_end().lines().collect();
    v[v.len().saturating_sub(lines)..].join("\n")
}

fn spawn_reader(mut r: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = r.by_ref().take(OUTPUT_LIMIT as u64).read_to_end(&mut buf);
        // drain the rest so the child never blocks on a full pipe
        let _ = std::io::copy(&mut r, &mut std::io::sink());
        let _ = tx.send(buf);
    });
    rx
}

/// `spawn`, retrying briefly on ETXTBSY: on Linux a script that was just written can
/// still be open for writing in a concurrently forked (not yet exec'd) process.
fn spawn_retrying(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    let mut tries = 0;
    loop {
        match cmd.spawn() {
            Err(e) if cfg!(unix) && e.raw_os_error() == Some(26) && tries < 50 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            r => return r,
        }
    }
}

/// Raw outcome of one uploader run.
pub struct RawRun {
    /// None: timed out or cancelled (the child was killed).
    pub status: Option<std::process::ExitStatus>,
    pub cancelled: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Run `argv + paths` directly (no shell), with a deadline and cancellation.
pub fn run_raw(argv: &[String], paths: &[String], timeout: Duration) -> Result<RawRun, String> {
    let (prog, args) = argv.split_first().ok_or("upload command is empty")?;
    let start_gen = cancel_gen();
    let mut cmd = Command::new(prog);
    cmd.args(args).args(paths).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "macos")]
    {
        // GUI apps start with a minimal PATH; Homebrew tools live here.
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
    let mut child = spawn_retrying(&mut cmd).map_err(|e| format!("cannot start uploader `{prog}`: {e}"))?;
    let out_rx = spawn_reader(child.stdout.take().expect("piped stdout"));
    let err_rx = spawn_reader(child.stderr.take().expect("piped stderr"));
    let deadline = Instant::now() + timeout;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break Some(st),
            None if Instant::now() >= deadline || cancel_gen() != start_gen => {
                cancelled = cancel_gen() != start_gen;
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    // A grandchild may still hold the pipes open; don't wait on it forever.
    let grace = Duration::from_millis(if status.is_some() { 2000 } else { 300 });
    let stdout = String::from_utf8_lossy(&out_rx.recv_timeout(grace).unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_rx.recv_timeout(grace).unwrap_or_default()).into_owned();
    Ok(RawRun { status, cancelled, stdout, stderr })
}

/// Interpret a raw run: success needs exit status 0 and one URL per image.
pub fn urls_of_run(r: &RawRun, n: usize, timeout: Duration) -> Result<Vec<String>, String> {
    let Some(status) = r.status else {
        return Err(if r.cancelled { "upload cancelled".into() } else { format!("uploader timed out after {}s and was stopped", timeout.as_secs()) });
    };
    if !status.success() {
        let detail = tail(if r.stderr.trim().is_empty() { &r.stdout } else { &r.stderr }, 5);
        return Err(format!("uploader failed ({status}): {detail}"));
    }
    extract_urls(&r.stdout, n).map_err(|e| {
        let detail = tail(&r.stdout, 5);
        if detail.is_empty() { e } else { format!("{e}; output:\n{detail}") }
    })
}

/// Run `argv + paths` directly (no shell) and return one URL per path.
pub fn run_command(argv: &[String], paths: &[String], timeout: Duration) -> Result<Vec<String>, String> {
    let r = run_raw(argv, paths, timeout)?;
    urls_of_run(&r, paths.len(), timeout)
}

/// POST `{"list": paths}` to PicGo's built-in server on 127.0.0.1 and return its URLs.
pub fn picgo_upload(port: u16, paths: &[String], timeout: Duration) -> Result<Vec<String>, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let fail = |e: std::io::Error| format!("PicGo server on 127.0.0.1:{port}: {e}");
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3).min(timeout)).map_err(fail)?;
    s.set_read_timeout(Some(timeout)).map_err(fail)?;
    s.set_write_timeout(Some(timeout)).map_err(fail)?;
    let body = serde_json::json!({ "list": paths }).to_string();
    let req = format!(
        "POST /upload HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).map_err(fail)?;
    let mut raw = Vec::new();
    s.take(OUTPUT_LIMIT as u64).read_to_end(&mut raw).map_err(|e| match e.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
            format!("PicGo server timed out after {}s", timeout.as_secs())
        }
        _ => fail(e),
    })?;
    let (status, body) = parse_http_response(&raw)?;
    if status != 200 {
        return Err(format!("PicGo server answered HTTP {status}: {}", tail(&body, 3)));
    }
    parse_picgo_body(&body, paths.len())
}

/// Minimal HTTP/1.x response parser: status code + body (Content-Length, chunked or EOF).
pub fn parse_http_response(raw: &[u8]) -> Result<(u16, String), String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("malformed HTTP response from PicGo")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut rest = &raw[split + 4..];
    let mut lines = head.lines();
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or("malformed HTTP status line from PicGo")?;
    let mut chunked = false;
    let mut length: Option<usize> = None;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        } else if k == "content-length" {
            length = v.parse().ok();
        }
    }
    let body = if chunked {
        let mut out = Vec::new();
        loop {
            let eol = rest.windows(2).position(|w| w == b"\r\n").ok_or("truncated chunked body")?;
            let size_str = String::from_utf8_lossy(&rest[..eol]);
            let size = usize::from_str_radix(size_str.split(';').next().unwrap_or("").trim(), 16)
                .map_err(|_| "bad chunk size in PicGo response")?;
            rest = &rest[eol + 2..];
            if size == 0 {
                break;
            }
            if rest.len() < size {
                return Err("truncated chunked body".into());
            }
            out.extend_from_slice(&rest[..size]);
            rest = rest.get(size + 2..).unwrap_or(&[]);
        }
        out
    } else {
        match length {
            Some(n) => rest.get(..n).ok_or("truncated PicGo response")?.to_vec(),
            None => rest.to_vec(),
        }
    };
    Ok((status, String::from_utf8_lossy(&body).into_owned()))
}

/// `{"success": true, "result": ["https://…", …]}` with one URL per image.
pub fn parse_picgo_body(body: &str, n: usize) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct Reply {
        success: bool,
        #[serde(default)]
        result: Vec<serde_json::Value>,
        #[serde(default)]
        message: Option<String>,
    }
    let r: Reply = serde_json::from_str(body).map_err(|e| format!("unexpected PicGo reply ({e}): {}", tail(body, 3)))?;
    if !r.success {
        return Err(format!("PicGo upload failed: {}", r.message.unwrap_or_else(|| tail(body, 3))));
    }
    let urls: Vec<String> = r.result.iter().filter_map(|v| v.as_str()).filter(|u| is_url(u)).map(|u| u.trim().to_string()).collect();
    if urls.len() != n || r.result.len() != n {
        return Err(format!("PicGo returned {} URL(s) for {} image(s)", urls.len(), n));
    }
    Ok(urls)
}

/// Upload `paths` with `config`; returns URLs in the same order.
pub fn upload(paths: &[String], config: &UploadConfig) -> Result<Vec<String>, String> {
    check_paths(paths)?;
    match config {
        UploadConfig::Command { command, timeout_secs } => {
            let argv = split_command(command)?;
            if argv.is_empty() {
                return Err("no upload command configured".into());
            }
            run_command(&argv, paths, batch_timeout(*timeout_secs, paths.len()))
        }
        UploadConfig::Picgo { port, timeout_secs } => {
            picgo_upload(port.unwrap_or(DEFAULT_PICGO_PORT), paths, batch_timeout(*timeout_secs, paths.len()))
        }
    }
}

#[tauri::command]
pub async fn upload_images(paths: Vec<String>, config: UploadConfig) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || upload(&paths, &config)).await.map_err(|e| e.to_string())?
}

/// Abort running uploads (the UI's Cancel on an in-flight upload).
#[tauri::command]
pub fn cancel_upload() {
    cancel_all();
}

/// Result of Preferences › Images › Test Uploader.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    pub ok: bool,
    /// What ran, for display: argv shell-quoted (it is *not* run through a shell).
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub urls: Vec<String>,
    pub message: String,
}

/// Display form of argv (single-quoted where needed).
pub fn display_argv(argv: &[String]) -> String {
    argv.iter()
        .map(|a| {
            if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c)) {
                a.clone()
            } else {
                format!("'{}'", a.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

const SAMPLE_A: &[u8] = include_bytes!("../icons/32x32.png");
const SAMPLE_B: &[u8] = include_bytes!("../icons/128x128.png");

fn sample_images() -> Result<(tempfile::TempDir, Vec<String>), String> {
    let dir = tempfile::Builder::new().prefix("margin-uploader-test").tempdir().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (name, bytes) in [("margin-test-1.png", SAMPLE_A), ("margin-test-2.png", SAMPLE_B)] {
        let p = dir.path().join(name);
        std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
        out.push(p.to_string_lossy().into_owned());
    }
    Ok((dir, out))
}

/// Upload two bundled sample images; passes only with exactly 2 URLs (Typora's rule).
pub fn test_upload(config: &UploadConfig, paths: &[String]) -> TestReport {
    let fail = |command: String, stdout: String, stderr: String, message: String| TestReport { ok: false, command, stdout, stderr, urls: vec![], message };
    match config {
        UploadConfig::Command { command, timeout_secs } => {
            let argv = match split_command(command) {
                Ok(a) if !a.is_empty() => a,
                Ok(_) => return fail(String::new(), String::new(), String::new(), "no upload command configured".into()),
                Err(e) => return fail(command.clone(), String::new(), String::new(), e),
            };
            let shown = display_argv(&[argv.clone(), paths.to_vec()].concat());
            let timeout = batch_timeout(*timeout_secs, paths.len());
            match run_raw(&argv, paths, timeout) {
                Err(e) => fail(shown, String::new(), String::new(), e),
                Ok(r) => match urls_of_run(&r, paths.len(), timeout) {
                    Ok(urls) => TestReport { ok: true, command: shown, stdout: r.stdout, stderr: r.stderr, urls, message: "Successfully get uploaded image url.".into() },
                    Err(e) => TestReport { urls: tail_urls(&r.stdout), ..fail(shown, r.stdout, r.stderr, e) },
                },
            }
        }
        UploadConfig::Picgo { port, timeout_secs } => {
            let port = port.unwrap_or(DEFAULT_PICGO_PORT);
            let shown = format!("POST http://127.0.0.1:{port}/upload");
            match picgo_upload(port, paths, batch_timeout(*timeout_secs, paths.len())) {
                Ok(urls) => TestReport { ok: true, command: shown, stdout: urls.join("\n"), stderr: String::new(), urls, message: "Successfully get uploaded image url.".into() },
                Err(e) => fail(shown, String::new(), String::new(), e),
            }
        }
    }
}

#[tauri::command]
pub async fn test_uploader(config: UploadConfig) -> Result<TestReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_dir, paths) = sample_images()?;
        Ok(test_upload(&config, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "upload_tests.rs"]
mod tests;
