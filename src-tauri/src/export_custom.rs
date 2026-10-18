//! Custom export commands and "run command after export" (#95, `typora.export.custom`).
//!
//! Unlike a login-shell `sh -c "<expanded string>"`, the command line is first
//! tokenized into argv (POSIX-style quoting, no expansion), and only *then* are
//! `${variables}` substituted inside each token — so a file name containing
//! `;`, `$( )` or spaces can never become extra shell syntax. No shell is spawned.

use crate::pandoc::{fallback_dirs, run_cancellable};
use std::sync::atomic::AtomicBool;
use crate::upload::split_command;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
}

/// Substitute `${name}` in one argv token; unknown names stay literal.
pub fn expand_token(tok: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(tok.len());
    let mut rest = tok;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match after.find('}') {
            Some(j) if after[..j].chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') => {
                let name = &after[..j];
                match vars.get(name) {
                    Some(v) => out.push_str(v),
                    None => out.push_str(&rest[i..i + 3 + j]),
                }
                rest = &after[j + 1..];
            }
            _ => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Tokenize then expand: the argv to execute.
pub fn build_argv(command: &str, vars: &HashMap<String, String>) -> Result<Vec<String>, String> {
    let argv: Vec<String> = split_command(command)
        .map_err(|e| e.replace("upload command", "export command"))?
        .iter()
        .map(|t| expand_token(t, vars))
        .collect();
    if argv.is_empty() || argv[0].is_empty() {
        return Err("No command configured.".into());
    }
    Ok(argv)
}

/// Resolve the executable: explicit paths as-is, bare names through PATH + common dirs.
pub fn which(name: &str, path_env: Option<&OsStr>, extra: &[PathBuf]) -> Result<PathBuf, String> {
    let p = Path::new(name);
    if name.contains('/') || name.contains('\\') {
        return if p.is_file() { Ok(p.to_path_buf()) } else { Err(format!("Command not found: {name}")) };
    }
    let mut dirs: Vec<PathBuf> = path_env.map(|v| std::env::split_paths(v).collect()).unwrap_or_default();
    dirs.extend(extra.iter().cloned());
    for d in dirs {
        let c = d.join(name);
        if c.is_file() {
            return Ok(c);
        }
        #[cfg(windows)]
        {
            let exe = d.join(format!("{name}.exe"));
            if exe.is_file() {
                return Ok(exe);
            }
        }
    }
    Err(format!("Command not found: {name} (not on PATH)"))
}

pub fn run_command(command: &str, vars: &HashMap<String, String>, stdin: Option<String>, cwd: Option<&Path>, timeout: Duration) -> Result<CommandOutput, String> {
    run_command_cancellable(command, vars, stdin, cwd, timeout, None)
}

/// [`run_command`] that the export sheet's Abort button can stop (#90) → `Err(pandoc::ABORTED)`.
pub fn run_command_cancellable(
    command: &str,
    vars: &HashMap<String, String>,
    stdin: Option<String>,
    cwd: Option<&Path>,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<CommandOutput, String> {
    let argv = build_argv(command, vars)?;
    let bin = which(&argv[0], std::env::var_os("PATH").as_deref(), &fallback_dirs())?;
    let out = run_cancellable(&bin, &argv[1..], stdin, cwd.filter(|d| d.is_dir()), timeout, cancel).map_err(|e| e.replace("Pandoc", "Command").replace("pandoc", "command"))?;
    let stderr: String = out.stderr.trim().chars().take(4000).collect();
    if !out.status.success() {
        return Err(if stderr.is_empty() { format!("Command failed ({})", out.status) } else { format!("Command failed ({}):\n{stderr}", out.status) });
    }
    Ok(CommandOutput { stdout: out.stdout.chars().take(64_000).collect(), stderr })
}

/// Run a custom export / after-export command. `stdin` = the document (Markdown or HTML).
#[tauri::command]
pub async fn run_export_command(
    command: String,
    vars: HashMap<String, String>,
    stdin: Option<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    export_id: Option<String>,
) -> Result<CommandOutput, String> {
    let cancel = export_id.as_deref().map(crate::pandoc::register);
    let id = export_id.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let timeout = timeout_ms.map(Duration::from_millis).unwrap_or(Duration::from_secs(120)).clamp(Duration::from_secs(1), Duration::from_secs(1800));
        let cwd = cwd.map(PathBuf::from).filter(|p| p.is_absolute());
        let res = run_command_cancellable(&command, &vars, stdin, cwd.as_deref(), timeout, cancel.as_deref());
        if let (Ok(_), Some(out)) = (&res, vars.get("outputPath").map(PathBuf::from).filter(|p| p.is_absolute() && p.exists())) {
            crate::export_cmds::record_export(&out);
        }
        res
    })
    .await
    .map_err(|e| format!("export task failed: {e}"));
    if let Some(id) = id {
        crate::pandoc::unregister(&id);
    }
    res?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(kv: &[(&str, &str)]) -> HashMap<String, String> {
        kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn expansion_is_per_token_so_values_cannot_inject_syntax() {
        let v = vars(&[("outputPath", "/tmp/a b; rm -rf ~.pdf"), ("today", "2026-10-18")]);
        let argv = build_argv("pandoc -o ${outputPath} --metadata date=${today} ${unknown} '${outputPath}'", &v).unwrap();
        assert_eq!(argv, vec!["pandoc", "-o", "/tmp/a b; rm -rf ~.pdf", "--metadata", "date=2026-10-18", "${unknown}", "/tmp/a b; rm -rf ~.pdf"]);
    }

    #[test]
    fn expand_edge_cases() {
        let v = vars(&[("a", "1")]);
        assert_eq!(expand_token("${a}${a}", &v), "11");
        assert_eq!(expand_token("${", &v), "${");
        assert_eq!(expand_token("x${a b}y", &v), "x${a b}y");
        assert_eq!(expand_token("$a", &v), "$a");
    }

    #[test]
    fn empty_and_bad_commands() {
        assert!(build_argv("   ", &HashMap::new()).unwrap_err().contains("No command"));
        assert!(build_argv("echo 'oops", &HashMap::new()).unwrap_err().contains("export command"));
        assert!(which("definitely-not-a-margin-cmd", Some(OsStr::new("/usr/bin")), &[]).is_err());
        assert!(which("/nonexistent/x", None, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn runs_with_stdin_cwd_and_reports_failures() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.txt");
        let v = vars(&[("outputPath", out.to_str().unwrap())]);
        let r = run_command("tee ${outputPath}", &v, Some("# Doc\n".into()), Some(dir.path()), Duration::from_secs(10)).unwrap();
        assert_eq!(r.stdout, "# Doc\n");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "# Doc\n");
        let pwd = run_command("pwd", &v, None, Some(dir.path()), Duration::from_secs(10)).unwrap();
        assert!(pwd.stdout.trim().ends_with(dir.path().file_name().unwrap().to_str().unwrap()));
        let e = run_command("sh -c 'echo nope >&2; exit 2'", &v, None, None, Duration::from_secs(10)).unwrap_err();
        assert!(e.contains("Command failed") && e.contains("nope"), "{e}");
        let t = run_command("sleep 5", &v, None, None, Duration::from_millis(300)).unwrap_err();
        assert!(t.contains("timed out"), "{t}");
    }
}
