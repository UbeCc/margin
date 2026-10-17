//! Inputs for `store_image` that aren't local files (#17): `data:` URLs (decoded
//! here) and `http(s)` URLs (downloaded with the system `curl`, present on macOS,
//! Windows 10+ and practically every Linux desktop; no TLS stack in our binary).

use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub const MAX_BYTES: u64 = 30 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(20);

pub struct Fetched {
    pub data: Vec<u8>,
    pub mime: Option<String>,
    /// File name from the URL path (no query/fragment), percent-decoded.
    pub name: Option<String>,
}

/// `data:[<mime>][;base64],<payload>`; only image types are accepted.
pub fn decode_data_url(url: &str) -> Option<Fetched> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mut parts = meta.split(';');
    let mime = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    let base64 = meta.split(';').any(|p| p.eq_ignore_ascii_case("base64"));
    if !mime.starts_with("image/") {
        return None;
    }
    let data = if base64 {
        let clean: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
        let clean = percent_encoding::percent_decode_str(&clean).decode_utf8_lossy().into_owned();
        b64(&clean)?
    } else {
        percent_encoding::percent_decode_str(payload).collect()
    };
    (!data.is_empty()).then_some(Fetched { data, mime: Some(mime), name: None })
}

fn b64(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let bytes: Vec<u8> = s.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c)? << (18 - 6 * i);
        }
        let k = chunk.len();
        if k < 2 {
            return None;
        }
        out.push((n >> 16) as u8);
        if k > 2 {
            out.push((n >> 8) as u8);
        }
        if k > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// Last path segment of an http(s) URL without `?query`/`#fragment`.
pub fn url_file_name(url: &str) -> Option<String> {
    let no_frag = url.split('#').next()?;
    let no_query = no_frag.split('?').next()?;
    let after_scheme = no_query.split_once("://")?.1;
    let path = after_scheme.split_once('/')?.1;
    let seg = path.rsplit('/').next()?;
    let name = percent_encoding::percent_decode_str(seg).decode_utf8_lossy().into_owned();
    let name = name.replace(['/', '\\', '\0'], "_");
    (!name.is_empty() && name != "." && name != "..").then_some(name)
}

/// Download an image. `Err` carries a short reason; the caller then keeps the URL.
pub fn download(url: &str, tmp_dir: &Path) -> Result<Fetched, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("not an http(s) URL".into());
    }
    let body = tempfile::NamedTempFile::new_in(tmp_dir).map_err(|e| e.to_string())?;
    let out = Command::new("curl")
        .args(["--silent", "--show-error", "--fail", "--location", "--max-redirs", "5"])
        .args(["--proto", "=http,https", "--proto-redir", "=http,https"])
        .args(["--max-time", &TIMEOUT.as_secs().to_string()])
        .args(["--max-filesize", &MAX_BYTES.to_string()])
        .args(["--write-out", "%{content_type}"])
        .arg("--output")
        .arg(body.path())
        .arg("--")
        .arg(url)
        .output()
        .map_err(|e| format!("curl unavailable: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let data = std::fs::read(body.path()).map_err(|e| e.to_string())?;
    let ctype = String::from_utf8_lossy(&out.stdout).split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let looks_image = ctype.starts_with("image/") || crate::images::sniff(&data).is_some();
    if data.is_empty() || !looks_image {
        return Err(format!("not an image (content-type {ctype:?})"));
    }
    Ok(Fetched { data, mime: ctype.starts_with("image/").then_some(ctype), name: url_file_name(url) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_urls() {
        let f = decode_data_url("data:image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(f.data, b"\x89PNG\r\n\x1a\n");
        assert_eq!(f.mime.as_deref(), Some("image/png"));
        let f = decode_data_url("data:image/svg+xml,%3Csvg%2F%3E").unwrap();
        assert_eq!(f.data, b"<svg/>");
        assert!(decode_data_url("data:text/html;base64,PGI+").is_none(), "non-images rejected");
        assert!(decode_data_url("data:image/png;base64,***").is_none());
        assert!(decode_data_url("data:image/png;base64,").is_none());
        let f = decode_data_url("data:image/gif;base64,R0lG\nODlh").unwrap();
        assert_eq!(&f.data[..6], b"GIF89a");
    }

    #[test]
    fn url_names() {
        assert_eq!(url_file_name("https://x.org/a/b/cat%20pic.png?w=200#top").as_deref(), Some("cat pic.png"));
        assert_eq!(url_file_name("https://x.org/").as_deref(), None);
        assert_eq!(url_file_name("https://x.org").as_deref(), None);
        assert_eq!(url_file_name("https://x.org/a/%2E%2E").as_deref(), None);
        assert_eq!(url_file_name("https://x.org/a/..%2Fetc%2Fpasswd").as_deref(), Some(".._etc_passwd"));
    }

    #[test]
    fn download_rejects_non_http_and_unreachable() {
        let d = tempfile::tempdir().unwrap();
        assert!(download("file:///etc/passwd", d.path()).is_err());
        assert!(download("http://127.0.0.1:9/x.png", d.path()).is_err());
    }

    #[test]
    fn download_from_local_server() {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let srv = std::thread::spawn(move || {
            for (ctype, body) in [("image/png", &b"\x89PNG\r\n\x1a\nxx"[..]), ("text/html", &b"<html>"[..])] {
                let (mut s, _) = l.accept().unwrap();
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                s.write_all(head.as_bytes()).unwrap();
                s.write_all(body).unwrap();
            }
        });
        let d = tempfile::tempdir().unwrap();
        let ok = download(&format!("http://127.0.0.1:{port}/img/shot.png?x=1"), d.path());
        let bad = download(&format!("http://127.0.0.1:{port}/page"), d.path());
        srv.join().unwrap();
        let ok = ok.unwrap();
        assert_eq!(ok.name.as_deref(), Some("shot.png"));
        assert_eq!(ok.mime.as_deref(), Some("image/png"));
        assert!(bad.is_err());
    }
}
