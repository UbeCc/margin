use super::*;
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[test]
fn split_command_shell_words() {
    assert_eq!(split_command("picgo upload").unwrap(), s(&["picgo", "upload"]));
    assert_eq!(split_command("  a   b\t c ").unwrap(), s(&["a", "b", "c"]));
    assert_eq!(split_command(r#"'/Apps/My Up/up' -o url"#).unwrap(), s(&["/Apps/My Up/up", "-o", "url"]));
    assert_eq!(split_command(r#""a \"b\" \$HOME \x" c"#).unwrap(), s(&[r#"a "b" $HOME \x"#, "c"]));
    assert_eq!(split_command(r"a\ b c\\d").unwrap(), s(&["a b", r"c\d"]));
    assert_eq!(split_command(r#"x "" ''"#).unwrap(), s(&["x", "", ""]));
    assert_eq!(split_command("ab'c d'\"e\"").unwrap(), s(&["abc de"]));
    // no expansion of any kind
    assert_eq!(split_command("echo $(touch pwned) `id` $HOME ~ *").unwrap(), s(&["echo", "$(touch", "pwned)", "`id`", "$HOME", "~", "*"]));
    assert_eq!(split_command("a \\\n b").unwrap(), s(&["a", "b"]));
    assert!(split_command("").unwrap().is_empty());
    assert!(split_command("a 'b").is_err());
    assert!(split_command("a \"b").is_err());
    assert!(split_command("a \\").is_err());
}

#[test]
fn extract_urls_from_tail() {
    let out = "Uploading...\nlog: https://not-at-tail.example\nDone:\nhttps://a.example/1.png\n  http://b.example/2.png  \n\n";
    assert_eq!(extract_urls(out, 2).unwrap(), s(&["https://a.example/1.png", "http://b.example/2.png"]));
    assert_eq!(extract_urls(out, 1).unwrap(), s(&["http://b.example/2.png"]));
    assert!(extract_urls(out, 3).is_err(), "count must match");
    assert!(extract_urls("https://x.example/a\nfinished", 1).is_err(), "URL must be at the tail");
    assert!(extract_urls("ftp://x/a\nhttps://bad url", 1).is_err());
    assert!(extract_urls("", 1).is_err());
}

#[test]
fn url_lines_follow_typora_rules() {
    assert_eq!(url_of_line("ftp://h/a.png").as_deref(), Some("ftp://h/a.png"));
    assert_eq!(url_of_line("file:///tmp/a.png").as_deref(), Some("file:///tmp/a.png"));
    assert_eq!(url_of_line("i.imgur.com/abc.png").as_deref(), Some("http://i.imgur.com/abc.png"));
    assert_eq!(url_of_line("cdn.example:8080/x").as_deref(), Some("http://cdn.example:8080/x"));
    for bad in ["Done:", "uploading 1/2", "a.b", "no-dot/path", "x.1/y", "https://", "https://a b"] {
        assert_eq!(url_of_line(bad), None, "{bad}");
    }
    // single image: the last URL wins even if the tail has more; a batch needs exactly n
    let out = "log\nhttps://a.example/1\nhttps://a.example/2\n";
    assert_eq!(extract_urls(out, 1).unwrap(), s(&["https://a.example/2"]));
    assert_eq!(extract_urls(out, 2).unwrap().len(), 2);
    assert!(extract_urls("https://a.example/0\nhttps://a.example/1\nhttps://a.example/2", 2).is_err());
    assert_eq!(display_argv(&s(&["/opt/up loader", "-u", "it's"])), "'/opt/up loader' -u 'it'\\''s'");
}

#[test]
fn timeout_scales_and_caps() {
    assert_eq!(batch_timeout(None, 1), Duration::from_secs(DEFAULT_PER_IMAGE_SECS));
    assert_eq!(batch_timeout(None, 1), Duration::from_secs(20));
    assert_eq!(batch_timeout(None, 2), Duration::from_secs(40));
    assert_eq!(batch_timeout(None, 5), Duration::from_secs(60), "Typora caps a batch at 60 s");
    assert_eq!(batch_timeout(Some(10), 3), Duration::from_secs(30));
    assert_eq!(batch_timeout(Some(100), 50), Duration::from_secs(100));
    assert_eq!(batch_timeout(Some(1000), 2), Duration::from_secs(MAX_TIMEOUT_SECS));
    assert_eq!(batch_timeout(Some(0), 0), Duration::from_secs(1));
}

#[test]
fn config_serde_matches_ts() {
    let c: UploadConfig = serde_json::from_str(r#"{"kind":"command","command":"up -u","timeoutSecs":5}"#).unwrap();
    assert_eq!(c, UploadConfig::Command { command: "up -u".into(), timeout_secs: Some(5) });
    let p: UploadConfig = serde_json::from_str(r#"{"kind":"picgo"}"#).unwrap();
    assert_eq!(p, UploadConfig::Picgo { port: None, timeout_secs: None });
}

#[test]
fn check_paths_rejects_relative_and_missing() {
    assert!(check_paths(&[]).is_err());
    assert!(check_paths(&s(&["rel.png"])).is_err());
    assert!(check_paths(&s(&["/definitely/missing/x.png"])).is_err());
}

#[test]
fn picgo_body_and_http_parsing() {
    assert_eq!(parse_picgo_body(r#"{"success":true,"result":["https://i/1"]}"#, 1).unwrap(), s(&["https://i/1"]));
    assert!(parse_picgo_body(r#"{"success":false,"message":"no config"}"#, 1).unwrap_err().contains("no config"));
    assert!(parse_picgo_body(r#"{"success":true,"result":["https://i/1"]}"#, 2).is_err());
    assert!(parse_picgo_body("<html>", 1).is_err());
    let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n2\r\nef\r\n0\r\n\r\n";
    assert_eq!(parse_http_response(chunked).unwrap(), (200, "abcdef".into()));
    let cl = b"HTTP/1.1 500 Err\r\nContent-Length: 3\r\n\r\nbadtrailing";
    assert_eq!(parse_http_response(cl).unwrap(), (500, "bad".into()));
    assert!(parse_http_response(b"garbage").is_err());
}

// ------------------------------------------------------------ process tests

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    /// Command-running tests share the global cancel generation: serialize them.
    static RUN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        RUN_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn image(dir: &Path, name: &str) -> String {
        let p = dir.join(name);
        fs::write(&p, b"\x89PNG fake").unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn hostile_file_names_are_plain_argv() {
        let _g = lock();
        let t = tempfile::tempdir().unwrap();
        let dir = t.path();
        // The fake uploader records its argv verbatim and prints one URL per arg.
        let log = dir.join("argv.log");
        let up = script(
            dir,
            "fake up.sh",
            &format!("for a in \"$@\"; do printf '%s\\n' \"$a\" >> '{}'; done\necho uploading\nshift 2\nfor a in \"$@\"; do echo \"https://cdn.example/$(basename \"$a\" | od -An -tx1 | tr -d ' \\n')\"; done", log.display()),
        );
        let names = ["$(touch pwned).png", "with space.png", "q\"uote's.png", "`touch pwned2`.png", "semi;touch pwned3.png"];
        let paths: Vec<String> = names.iter().map(|n| image(dir, n)).collect();
        let command = format!("'{}' --flag \"two words\"", up.display());
        let cwd = std::env::current_dir().unwrap();
        let urls = upload(&paths, &UploadConfig::Command { command, timeout_secs: Some(10) }).unwrap();
        assert_eq!(urls.len(), names.len());
        assert!(urls.iter().all(|u| u.starts_with("https://cdn.example/")));
        let logged = fs::read_to_string(&log).unwrap();
        let mut expect = vec!["--flag".to_string(), "two words".to_string()];
        expect.extend(paths.iter().cloned());
        assert_eq!(logged.lines().map(String::from).collect::<Vec<_>>(), expect);
        for d in [dir, cwd.as_path()] {
            for p in ["pwned", "pwned2", "pwned3"] {
                assert!(!d.join(p).exists(), "command injection: {p} created in {}", d.display());
            }
        }
    }

    #[test]
    fn url_count_mismatch_is_an_error() {
        let _g = lock();
        let t = tempfile::tempdir().unwrap();
        let up = script(t.path(), "one.sh", "echo https://cdn.example/only-one");
        let paths = vec![image(t.path(), "a.png"), image(t.path(), "b.png")];
        let e = upload(&paths, &UploadConfig::Command { command: up.display().to_string(), timeout_secs: Some(5) }).unwrap_err();
        assert!(e.contains("1 URL(s) for 2 image(s)"), "{e}");
    }

    #[test]
    fn failing_uploader_reports_stderr() {
        let _g = lock();
        let t = tempfile::tempdir().unwrap();
        let up = script(t.path(), "fail.sh", "echo 'token expired' >&2\nexit 3");
        let e = upload(&[image(t.path(), "a.png")], &UploadConfig::Command { command: up.display().to_string(), timeout_secs: Some(5) }).unwrap_err();
        assert!(e.contains("token expired"), "{e}");
    }

    #[test]
    fn missing_program_is_an_error() {
        let _g = lock();
        let t = tempfile::tempdir().unwrap();
        let e = upload(&[image(t.path(), "a.png")], &UploadConfig::Command { command: "/no/such/uploader".into(), timeout_secs: Some(5) }).unwrap_err();
        assert!(e.contains("cannot start uploader"), "{e}");
    }

    #[test]
    fn timeout_kills_child() {
        let _g = lock();
        let t = tempfile::tempdir().unwrap();
        let marker = t.path().join("finished");
        // Not `exec`: the shell's own child (sleep) keeps the pipes open after the kill.
        let up = script(t.path(), "slow.sh", &format!("sleep 5\ntouch '{}'\necho https://late.example/x", marker.display()));
        let start = Instant::now();
        let e = run_command(&[up.display().to_string()], &[image(t.path(), "a.png")], Duration::from_millis(400)).unwrap_err();
        assert!(e.contains("timed out"), "{e}");
        assert!(start.elapsed() < Duration::from_secs(3), "took {:?}", start.elapsed());
        std::thread::sleep(Duration::from_secs(6));
        assert!(!marker.exists(), "child was not killed");
    }

    #[test]
    fn test_upload_needs_exactly_two_urls_and_shows_argv() {
        let _g = lock();
        let t = tempfile::tempdir().unwrap();
        let two = script(t.path(), "two.sh", "echo working\nshift\ni=0\nfor a in \"$@\"; do i=$((i+1)); echo \"https://cdn.example/$i.png\"; done");
        let paths = vec![image(t.path(), "a.png"), image(t.path(), "b c.png")];
        let r = test_upload(&UploadConfig::Command { command: format!("'{}' -u", two.display()), timeout_secs: Some(5) }, &paths);
        assert!(r.ok, "{r:?}");
        assert_eq!(r.urls, s(&["https://cdn.example/1.png", "https://cdn.example/2.png"]));
        assert!(r.command.contains("-u") && r.command.contains("'"), "{}", r.command);
        assert!(r.stdout.contains("working"));
        let one = script(t.path(), "one.sh", "echo https://cdn.example/only");
        let r = test_upload(&UploadConfig::Command { command: one.display().to_string(), timeout_secs: Some(5) }, &paths);
        assert!(!r.ok && r.message.contains("1 URL(s) for 2"), "{r:?}");
        assert_eq!(r.urls, s(&["https://cdn.example/only"]));
    }

    #[test]
    fn cancel_kills_a_running_upload() {
        let _g = lock();
        let t = tempfile::tempdir().unwrap();
        let slow = script(t.path(), "slow.sh", "sleep 5\necho https://late.example/x");
        let img = image(t.path(), "a.png");
        let start = Instant::now();
        let h = std::thread::spawn(move || run_command(&[slow.display().to_string()], &[img], Duration::from_secs(20)));
        std::thread::sleep(Duration::from_millis(200));
        cancel_all();
        let e = h.join().unwrap().unwrap_err();
        assert_eq!(e, "upload cancelled");
        assert!(start.elapsed() < Duration::from_secs(4), "took {:?}", start.elapsed());
    }
}

// ------------------------------------------------------------ fake PicGo

fn fake_picgo(reply: &'static str) -> (u16, std::thread::JoinHandle<String>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let h = std::thread::spawn(move || {
        let (mut c, _) = l.accept().unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = c.read(&mut buf).unwrap();
            req.extend_from_slice(&buf[..n]);
            if let Some(i) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&req[..i]).to_ascii_lowercase();
                let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).map(|v| v.trim().parse().unwrap()).unwrap_or(0);
                if req.len() >= i + 4 + len {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        c.write_all(reply.as_bytes()).unwrap();
        String::from_utf8_lossy(&req).into_owned()
    });
    (port, h)
}

#[test]
fn picgo_server_roundtrip() {
    let t = tempfile::tempdir().unwrap();
    let a = t.path().join("a b.png");
    let b = t.path().join("$(x).png");
    fs::write(&a, b"1").unwrap();
    fs::write(&b, b"2").unwrap();
    let paths = vec![a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()];
    let body = r#"{"success":true,"result":["https://img.example/1.png","https://img.example/2.png"]}"#;
    let reply: &'static str = Box::leak(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_boxed_str());
    let (port, h) = fake_picgo(reply);
    let urls = upload(&paths, &UploadConfig::Picgo { port: Some(port), timeout_secs: Some(5) }).unwrap();
    assert_eq!(urls, s(&["https://img.example/1.png", "https://img.example/2.png"]));
    let req = h.join().unwrap();
    assert!(req.starts_with("POST /upload HTTP/1.1\r\n"), "{req}");
    let json = &req[req.find("\r\n\r\n").unwrap() + 4..];
    let v: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(v, serde_json::json!({ "list": paths }));
}

#[test]
fn picgo_failure_and_unreachable() {
    let t = tempfile::tempdir().unwrap();
    let a = t.path().join("a.png");
    fs::write(&a, b"1").unwrap();
    let paths = vec![a.to_string_lossy().into_owned()];
    let (port, h) = fake_picgo("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"success\":false,\"message\":\"uploader not set\"}");
    let e = upload(&paths, &UploadConfig::Picgo { port: Some(port), timeout_secs: Some(5) }).unwrap_err();
    assert!(e.contains("uploader not set"), "{e}");
    h.join().unwrap();
    // nothing listening on a freshly released port
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let e = upload(&paths, &UploadConfig::Picgo { port: Some(port), timeout_secs: Some(2) }).unwrap_err();
    assert!(e.contains("127.0.0.1"), "{e}");
}
