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

fn is_url(line: &str) -> bool {
    let l = line.trim();
    (l.starts_with("https://") || l.starts_with("http://"))
        && l.len() > "http://x".len()
        && !l.chars().any(char::is_whitespace)
}

/// URLs from the tail of an uploader's output: scanning backwards (ignoring blank
/// lines) collects the contiguous run of `http(s)://` lines. Exactly one URL per
/// image is required; when the run is longer, the last `n` are used.
pub fn extract_urls(stdout: &str, n: usize) -> Result<Vec<String>, String> {
    let mut found: Vec<String> = Vec::new();
    for line in stdout.lines().rev() {
        if line.trim().is_empty() {
            continue;
        }
        if !is_url(line) {
            break;
        }
        found.push(line.trim().to_string());
    }
    found.reverse();
    if found.len() < n {
        return Err(format!("uploader returned {} URL(s) for {} image(s)", found.len(), n));
    }
    Ok(found.split_off(found.len() - n))
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

/// Run `argv + paths` directly (no shell) and return one URL per path.
pub fn run_command(argv: &[String], paths: &[String], timeout: Duration) -> Result<Vec<String>, String> {
    let (prog, args) = argv.split_first().ok_or("upload command is empty")?;
    let mut cmd = Command::new(prog);
    cmd.args(args).args(paths).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "macos")]
    {
        // GUI apps start with a minimal PATH; Homebrew tools live here.
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot start uploader `{prog}`: {e}"))?;
    let out_rx = spawn_reader(child.stdout.take().expect("piped stdout"));
    let err_rx = spawn_reader(child.stderr.take().expect("piped stderr"));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break Some(st),
            None if Instant::now() >= deadline => {
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
    let Some(status) = status else {
        return Err(format!("uploader timed out after {}s and was stopped", timeout.as_secs()));
    };
    if !status.success() {
        let detail = tail(if stderr.trim().is_empty() { &stdout } else { &stderr }, 5);
        return Err(format!("uploader failed ({status}): {detail}"));
    }
    extract_urls(&stdout, paths.len()).map_err(|e| {
        let detail = tail(&stdout, 5);
        if detail.is_empty() { e } else { format!("{e}; output:\n{detail}") }
    })
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

#[cfg(test)]
#[path = "upload_tests.rs"]
mod tests;
