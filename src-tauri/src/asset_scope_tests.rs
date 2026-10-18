//! Asset-protocol scope: what Margin grants for an opened file/folder, checked both
//! as a pure plan (`asset_grants`) and against Tauri's real scope matcher.

use crate::asset_grants;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn grant(scope: &tauri::scope::fs::Scope, dir: &Path, home: Option<&Path>, recursive: bool) {
    for (p, rec) in asset_grants(dir, home, recursive) {
        scope.allow_directory(&p, rec).unwrap();
    }
}

struct Fixture {
    _t: tempfile::TempDir,
    root: PathBuf,
}

/// root/{home/notes/{a.png, sub/b.png, escape -> ../../secret}, secret/key.txt, home/top.txt}
fn fixture() -> Fixture {
    let t = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(t.path()).unwrap();
    fs::create_dir_all(root.join("home/notes/sub")).unwrap();
    fs::create_dir_all(root.join("secret")).unwrap();
    fs::write(root.join("home/notes/a.png"), "x").unwrap();
    fs::write(root.join("home/notes/sub/b.png"), "x").unwrap();
    fs::write(root.join("home/top.txt"), "x").unwrap();
    fs::write(root.join("home/.netrc"), "x").unwrap();
    fs::write(root.join("secret/key.txt"), "x").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("../../secret", root.join("home/notes/escape")).unwrap();
    Fixture { _t: t, root }
}

#[test]
fn plan_for_plain_and_dotdot_paths() {
    let f = fixture();
    let home = f.root.join("home");
    let notes = home.join("notes");
    assert_eq!(asset_grants(&notes, Some(&home), true), vec![(notes.clone(), true)]);
    // `notes/..` is the home directory: never recursive
    let up = notes.join("..");
    assert!(asset_grants(&up, Some(&home), true).iter().all(|(_, rec)| !rec));
    assert_eq!(asset_grants(&up, Some(&home), true)[0].0, home);
    // filesystem root / home's parent
    assert!(asset_grants(Path::new("/"), Some(&home), true).iter().all(|(_, r)| !r));
    assert!(asset_grants(&f.root, Some(&home), true).iter().all(|(_, r)| !r), "parent of home");
}

#[cfg(unix)]
#[test]
fn plan_for_symlink_to_broad_dir() {
    let f = fixture();
    let home = f.root.join("home");
    let link = f.root.join("secret/to-home");
    std::os::unix::fs::symlink(&home, &link).unwrap();
    let g = asset_grants(&link, Some(&home), true);
    assert!(g.iter().all(|(_, r)| !r), "{g:?}");
    let to_root = f.root.join("secret/to-root");
    std::os::unix::fs::symlink("/", &to_root).unwrap();
    assert!(asset_grants(&to_root, Some(&home), true).iter().all(|(_, r)| !r));
}

#[test]
fn real_scope_allows_inside_and_denies_outside() {
    let f = fixture();
    let app = tauri::test::mock_app();
    let scope = app.asset_protocol_scope();
    let home = f.root.join("home");
    let notes = home.join("notes");
    grant(&scope, &notes, Some(&home), true);
    assert!(scope.is_allowed(notes.join("a.png")));
    assert!(scope.is_allowed(notes.join("sub/b.png")));
    assert!(!scope.is_allowed(home.join("top.txt")), "sibling of the opened folder");
    assert!(!scope.is_allowed(notes.join("../top.txt")), "`..` traversal");
    assert!(!scope.is_allowed(notes.join("sub/../../top.txt")));
    assert!(!scope.is_allowed(f.root.join("secret/key.txt")));
    #[cfg(unix)]
    assert!(!scope.is_allowed(notes.join("escape/key.txt")), "symlink escape");
}

#[test]
fn real_scope_dotdot_grant_does_not_open_home_recursively() {
    let f = fixture();
    let app = tauri::test::mock_app();
    let scope = app.asset_protocol_scope();
    let home = f.root.join("home");
    grant(&scope, &home.join("notes/.."), Some(&home), true);
    assert!(scope.is_allowed(home.join("top.txt")), "direct children of home are allowed");
    assert!(!scope.is_allowed(home.join("notes/a.png")), "but not recursively");
}

#[test]
fn deny_list_covers_credentials() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let deny: Vec<String> = conf["app"]["security"]["assetProtocol"]["scope"]["deny"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let m = |p: &str| deny.iter().any(|g| glob_match(g, p));
    for p in [
        "/Users/me/.ssh/id_rsa",
        "/Users/me/.netrc",
        "/Users/me/.git-credentials",
        "/Users/me/.aws/credentials",
        "/Users/me/.kube/config",
        "/Users/me/.docker/config.json",
        "/Users/me/.config/gh/hosts.yml",
        "/Users/me/.npmrc",
        "/Users/me/.pypirc",
        "/home/me/.gnupg/x",
        "/Users/me/Library/Keychains/login.keychain-db",
        "/Users/me/Library/Cookies/Cookies.binarycookies",
    ] {
        assert!(m(p), "{p} not denied");
    }
    assert!(!m("/Users/me/notes/img.png"));
}

/// Tiny glob for the deny patterns (`**` any path, `*` within a segment).
fn glob_match(pat: &str, path: &str) -> bool {
    fn go(p: &[u8], s: &[u8]) -> bool {
        match p {
            [] => s.is_empty(),
            [b'*', b'*', rest @ ..] => (0..=s.len()).any(|i| go(rest, &s[i..])),
            [b'*', rest @ ..] => (0..=s.len()).take_while(|&i| i == 0 || s[i - 1] != b'/').any(|i| go(rest, &s[i..])),
            [c, rest @ ..] => s.first() == Some(c) && go(rest, &s[1..]),
        }
    }
    go(pat.as_bytes(), path.as_bytes())
}
