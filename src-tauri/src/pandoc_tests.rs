use super::*;

fn dirs_none() -> Vec<PathBuf> {
    vec![]
}

#[test]
fn parses_versions() {
    assert_eq!(parse_version("pandoc 3.1.9\nFeatures: +server").as_deref(), Some("3.1.9"));
    assert_eq!(parse_version("pandoc.exe 2.19.2\n").as_deref(), Some("2.19.2"));
    assert_eq!(parse_version("pandoc 1.19.2.1").as_deref(), Some("1.19.2.1"));
    assert_eq!(parse_version("pandoc 3.4."), Some("3.4".into()));
    assert_eq!(parse_version("hello world"), None);
    assert_eq!(parse_version(""), None);
    assert_eq!(major("3.1.9"), 3);
    assert_eq!(major("1.19"), 1);
}

#[test]
fn writer_table() {
    assert_eq!(writer_for("docx").unwrap().0, "docx");
    assert_eq!(writer_for("latex").unwrap().1, &["--standalone"]);
    assert_eq!(writer_for("epub").unwrap().0, "epub");
    assert!(writer_for("pdf").is_none());
    assert!(writer_for("docx; rm -rf /").is_none());
}

#[test]
fn args_are_argv_with_resource_path() {
    let out = PathBuf::from("/tmp/x/out.tex");
    let req = ExportRequest {
        markdown: String::new(),
        out: &out,
        format: "latex",
        doc_dir: Some(Path::new("/docs/my notes")),
        title: Some("A \"title\" $(x)"),
        timeout: DEFAULT_TIMEOUT,
        options: Default::default(),
        cancel: None,
    };
    let a = export_args(&req).unwrap();
    assert_eq!(
        a,
        vec![
            "-f", "markdown", "-t", "latex", "--standalone", "-o", "/tmp/x/out.tex", "--resource-path", "/docs/my notes",
            "--metadata=pagetitle:A \"title\" $(x)",
        ]
    );
    let req2 = ExportRequest { doc_dir: None, title: None, format: "docx", ..req };
    let a2 = export_args(&req2).unwrap();
    assert_eq!(a2[a2.len() - 1], "/tmp/x");
    assert!(!a2.contains(&"--standalone".to_string()));
    let bad = ExportRequest { format: "html", ..req2 };
    assert!(export_args(&bad).unwrap_err().contains("Unsupported"));
}

#[test]
fn option_args_follow_typora_order_and_expand_vars() {
    let o = PandocOptions {
        pdf_engine: "xelatex".into(),
        css: "style.css".into(),
        reference_doc: "${currentFolder}/ref.docx".into(),
        template: " tpl.tex ".into(),
        epub_chapter_level: 2,
        toc: true,
        extra_arguments: "--number-sections -V 'geometry:margin=1in' ${outputPath}".into(),
    };
    let vars = arg_vars(Path::new("/o/x y.pdf"), Some(Path::new("/d")), Some("T"));
    assert_eq!(
        option_args(&o, &vars).unwrap(),
        vec![
            "--pdf-engine=xelatex", "--css", "style.css", "--reference-doc", "/d/ref.docx", "--template", "tpl.tex",
            "--epub-chapter-level=2", "--toc", "--number-sections", "-V", "geometry:margin=1in", "/o/x y.pdf",
        ]
    );
    // A file name with shell syntax stays one argv element; nothing is executed.
    let vars = arg_vars(Path::new("/o/a; rm -rf ~.docx"), None, None);
    let a = option_args(&PandocOptions { extra_arguments: "--metadata=src:${outputPath}".into(), ..Default::default() }, &vars).unwrap();
    assert_eq!(a, vec!["--metadata=src:/o/a; rm -rf ~.docx"]);
    assert!(option_args(&PandocOptions::default(), &vars).unwrap().is_empty());
    assert!(option_args(&PandocOptions { extra_arguments: "--x 'open".into(), ..Default::default() }, &vars).unwrap_err().contains("Extra arguments"));
}

#[test]
fn resolve_reports_missing_configured_path() {
    let e = resolve(Some("/nonexistent/pandoc"), None, &dirs_none()).unwrap_err();
    assert!(e.contains("/nonexistent/pandoc") && e.contains("Preferences"), "{e}");
    let e = resolve(None, Some(OsStr::new("/nonexistent-a:/nonexistent-b")), &dirs_none()).unwrap_err();
    assert!(e.contains("Pandoc not found"), "{e}");
    // Relative PATH entries are ignored (never resolve against our cwd).
    assert!(resolve(None, Some(OsStr::new(".")), &dirs_none()).is_err());
}

#[cfg(unix)]
mod fake {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    /// A fake `pandoc`: `--version` prints VERSION; otherwise copies stdin to the `-o`
    /// path and logs argv + cwd next to itself.
    fn script(dir: &Path, version: &str, body: &str, mode: u32) -> PathBuf {
        let p = dir.join("pandoc");
        let text = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"pandoc {version}\"; echo 'Features: +x'; exit 0; fi\n\
             printf '%s\\n' \"$@\" > \"{log}\"\npwd > \"{cwd}\"\n{body}\n",
            log = dir.join("argv.log").display(),
            cwd = dir.join("cwd.log").display(),
        );
        std::fs::write(&p, text).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    const COPY: &str = "out=''; prev=''; for a in \"$@\"; do [ \"$prev\" = \"-o\" ] && out=\"$a\"; prev=\"$a\"; done\n\
                        cat > \"$out\"\necho '[WARNING] something minor' >&2";

    fn req<'a>(md: &str, out: &'a Path, doc: &'a Path, t: Duration) -> ExportRequest<'a> {
        ExportRequest { markdown: md.into(), out, format: "docx", doc_dir: Some(doc), title: None, timeout: t, options: Default::default(), cancel: None }
    }

    #[test]
    fn ok_export_pipes_stdin_sets_cwd_and_returns_warnings() {
        let tmp = TempDir::new().unwrap();
        let bin = script(tmp.path(), "3.1.9", COPY, 0o755);
        let doc = tmp.path().join("doc dir");
        std::fs::create_dir(&doc).unwrap();
        let out = tmp.path().join("out.docx");
        // Large input: proves stdin is written concurrently (no pipe deadlock).
        let md = "# Héllo\n\n".to_string() + &"lorem ipsum ".repeat(200_000);
        let warn = export(&bin, req(&md, &out, &doc, Duration::from_secs(20))).unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), md);
        assert!(warn.contains("WARNING"), "{warn}");
        let argv = std::fs::read_to_string(tmp.path().join("argv.log")).unwrap();
        assert!(argv.starts_with("-f\nmarkdown\n-t\ndocx\n-o\n"), "{argv}");
        assert!(argv.contains("--resource-path\n") && argv.contains("doc dir"), "{argv}");
        let cwd = std::fs::read_to_string(tmp.path().join("cwd.log")).unwrap();
        assert!(cwd.trim().ends_with("doc dir"), "{cwd}");
    }

    #[test]
    fn detect_accepts_v2_plus_from_configured_dir_and_path() {
        let tmp = TempDir::new().unwrap();
        script(tmp.path(), "2.19.2", COPY, 0o755);
        let dir = tmp.path().to_string_lossy().into_owned();
        let info = detect(Some(&dir), None, &dirs_none(), VERSION_TIMEOUT).unwrap();
        assert_eq!(info.version, "2.19.2");
        let info = detect(None, Some(tmp.path().as_os_str()), &dirs_none(), VERSION_TIMEOUT).unwrap();
        assert!(info.path.ends_with("/pandoc"));
        // Fallback dirs are searched when PATH lacks it (GUI apps).
        let info = detect(None, Some(OsStr::new("/nonexistent")), &[tmp.path().to_path_buf()], VERSION_TIMEOUT).unwrap();
        assert_eq!(info.version, "2.19.2");
    }

    #[test]
    fn detect_rejects_old_version() {
        let tmp = TempDir::new().unwrap();
        let bin = script(tmp.path(), "1.19.2.1", COPY, 0o755);
        let e = detect(Some(bin.to_str().unwrap()), None, &dirs_none(), VERSION_TIMEOUT).unwrap_err();
        assert!(e.contains("1.19.2.1") && e.contains("too old"), "{e}");
    }

    #[test]
    fn nonzero_exit_surfaces_stderr() {
        let tmp = TempDir::new().unwrap();
        let bin = script(tmp.path(), "3.0", "cat >/dev/null; echo 'Could not find image `x.png`' >&2; exit 83", 0o755);
        let out = tmp.path().join("o.docx");
        let e = export(&bin, req("![](x.png)", &out, tmp.path(), Duration::from_secs(10))).unwrap_err();
        assert!(e.contains("Pandoc failed") && e.contains("83") && e.contains("Could not find image"), "{e}");
    }

    #[test]
    fn success_without_output_is_an_error() {
        let tmp = TempDir::new().unwrap();
        let bin = script(tmp.path(), "3.0", "cat >/dev/null; exit 0", 0o755);
        let out = tmp.path().join("missing.docx");
        let e = export(&bin, req("x", &out, tmp.path(), Duration::from_secs(10))).unwrap_err();
        assert!(e.contains("did not create"), "{e}");
    }

    #[test]
    fn hang_times_out_and_kills() {
        let tmp = TempDir::new().unwrap();
        // No `exec`: the sleeping grandchild keeps stdout/stderr open after sh is killed.
        let bin = script(tmp.path(), "3.0", "echo 'starting' >&2; sleep 30", 0o755);
        let out = tmp.path().join("o.docx");
        let t0 = Instant::now();
        let e = export(&bin, req("x", &out, tmp.path(), Duration::from_millis(700))).unwrap_err();
        assert!(e.contains("timed out"), "{e}");
        assert!(t0.elapsed() < Duration::from_secs(8), "took {:?}", t0.elapsed());
        // The version probe is bounded too.
        let hang_ver = tmp.path().join("v");
        std::fs::create_dir(&hang_ver).unwrap();
        let p = hang_ver.join("pandoc");
        std::fs::write(&p, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = detect(Some(p.to_str().unwrap()), None, &dirs_none(), Duration::from_millis(500)).unwrap_err();
        assert!(e.contains("timed out"), "{e}");
    }

    #[test]
    fn abort_kills_running_export() {
        let tmp = TempDir::new().unwrap();
        let bin = script(tmp.path(), "3.0", "sleep 30", 0o755);
        let out = tmp.path().join("o.docx");
        let flag = register("t-abort");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            assert!(abort("t-abort"));
        });
        let t0 = Instant::now();
        let mut r = req("x", &out, tmp.path(), Duration::from_secs(20));
        r.cancel = Some(flag);
        let e = export(&bin, r).unwrap_err();
        assert_eq!(e, ABORTED);
        assert!(t0.elapsed() < Duration::from_secs(8), "took {:?}", t0.elapsed());
        unregister("t-abort");
        assert!(!abort("t-abort"), "finished exports are no longer abortable");
    }

    #[test]
    fn options_reach_pandoc_argv() {
        let tmp = TempDir::new().unwrap();
        let bin = script(tmp.path(), "3.1", COPY, 0o755);
        let out = tmp.path().join("my out.docx");
        let mut r = req("x", &out, tmp.path(), Duration::from_secs(10));
        r.options = PandocOptions { reference_doc: "ref.docx".into(), extra_arguments: "--toc -M \"lang=${title}\"".into(), ..Default::default() };
        r.title = Some("T 1");
        export(&bin, r).unwrap();
        let argv = std::fs::read_to_string(tmp.path().join("argv.log")).unwrap();
        let lines: Vec<&str> = argv.lines().collect();
        let i = lines.iter().position(|l| *l == "--reference-doc").expect("flag");
        assert_eq!(lines[i + 1], "ref.docx");
        assert!(lines.ends_with(&["--toc", "-M", "lang=T 1"]), "{lines:?}");
    }

    #[test]
    fn not_executable_is_reported() {
        let tmp = TempDir::new().unwrap();
        let bin = script(tmp.path(), "3.0", COPY, 0o644);
        let e = detect(Some(bin.to_str().unwrap()), None, &dirs_none(), VERSION_TIMEOUT).unwrap_err();
        assert!(e.contains("not executable"), "{e}");
        let out = tmp.path().join("o.docx");
        let e = export(&bin, req("x", &out, tmp.path(), Duration::from_secs(5))).unwrap_err();
        assert!(e.contains("not executable"), "{e}");
    }

    #[test]
    fn garbage_version_output_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("pandoc");
        std::fs::write(&p, "#!/bin/sh\necho 'hello'\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = detect(Some(p.to_str().unwrap()), None, &dirs_none(), VERSION_TIMEOUT).unwrap_err();
        assert!(e.contains("doesn't look like pandoc"), "{e}");
    }

    /// Real pandoc, when installed: `cargo test -- --ignored real_pandoc`.
    #[test]
    #[ignore]
    fn real_pandoc_exports_all_formats() {
        let info = detect(None, std::env::var_os("PATH").as_deref(), &fallback_dirs(), VERSION_TIMEOUT).expect("pandoc installed");
        let bin = PathBuf::from(&info.path);
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("img.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        for (fmt, ext) in [("docx", "docx"), ("latex", "tex"), ("epub", "epub"), ("odt", "odt"), ("rtf", "rtf"), ("mediawiki", "wiki"), ("rst", "rst"), ("textile", "textile"), ("opml", "opml")] {
            let out = tmp.path().join(format!("out.{ext}"));
            let r = ExportRequest {
                markdown: "# Title\n\nSome *text* and $x^2$.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n".into(),
                out: &out,
                format: fmt,
                doc_dir: Some(tmp.path()),
                title: Some("Title"),
                timeout: DEFAULT_TIMEOUT,
                options: Default::default(),
                cancel: None,
            };
            export(&bin, r).unwrap_or_else(|e| panic!("{fmt}: {e}"));
            assert!(std::fs::metadata(&out).unwrap().len() > 20, "{fmt}");
        }
        assert!(std::fs::read_to_string(tmp.path().join("out.tex")).unwrap().contains("\\begin{document}"));
    }
}
