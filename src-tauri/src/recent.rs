//! File › Open Recent (native submenu fed from settings `recentFiles`/`recentFolders`)
//! and second-instance argument forwarding.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{IsMenuItem, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

pub const SUBMENU_ID: &str = "submenu:recent";
pub const ID_PREFIX: &str = "recent:";
/// Forwarded to the frontend as a `MenuAction` so it clears its in-memory recents too.
pub const ID_CLEAR: &str = "clearRecent";
pub const MAX_ITEMS: usize = 15;

/// Paths behind the `recent:<n>` menu ids.
#[derive(Default)]
pub struct RecentState(pub Mutex<Vec<String>>);

/// One menu entry: label and path. Files first, then folders; missing entries and
/// duplicates dropped; at most `MAX_ITEMS`. Labels are `name — parent` and get the
/// parent's own name too when two entries would otherwise look the same.
pub fn entries(files: &[String], folders: &[String], home: Option<&Path>) -> Vec<(String, String)> {
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for p in files.iter().chain(folders) {
        if seen.contains(p) || !Path::new(p).exists() {
            continue;
        }
        seen.push(p.clone());
        out.push((label(Path::new(p), home), p.clone()));
        if out.len() == MAX_ITEMS {
            break;
        }
    }
    out
}

fn tilde(p: &Path, home: Option<&Path>) -> String {
    match home.and_then(|h| p.strip_prefix(h).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~/{}", rest.to_string_lossy()),
        None => p.to_string_lossy().into_owned(),
    }
}

pub fn label(p: &Path, home: Option<&Path>) -> String {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned());
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => format!("{name} — {}", tilde(parent, home)),
        _ => name,
    }
}

/// Files/folders named on a (second instance's) command line, resolved against its
/// working directory. Flags (`-x`, `--y`, `-psn_…` from old macOS) are skipped, as is
/// argv[0] when `skip_program` is set.
pub fn paths_from_args(args: &[String], cwd: &Path, skip_program: bool) -> Vec<PathBuf> {
    let mut only_paths = false;
    args.iter()
        .skip(usize::from(skip_program))
        .filter(|a| {
            if only_paths {
                return true;
            }
            if *a == "--" {
                only_paths = true;
                return false;
            }
            !a.starts_with('-')
        })
        .map(|a| {
            // `xdg-open`/file managers may pass file:// URIs (%U)
            let s = a.strip_prefix("file://").map(|r| percent_encoding::percent_decode_str(r).decode_utf8_lossy().into_owned());
            let p = PathBuf::from(s.unwrap_or_else(|| a.clone()));
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .map(|p| crate::images::normalize(&p))
        .filter(|p| p.exists())
        .collect()
}

/// Rebuild the Open Recent submenu.
pub fn set_menu<R: Runtime>(app: &AppHandle<R>, files: &[String], folders: &[String]) -> tauri::Result<()> {
    let home = app.path().home_dir().ok();
    let list = entries(files, folders, home.as_deref());
    if let Some(state) = app.try_state::<RecentState>() {
        *state.0.lock().unwrap() = list.iter().map(|(_, p)| p.clone()).collect();
    }
    let Some(menu) = app.menu() else { return Ok(()) };
    let Some(sub) = find_submenu(&menu.items()?, SUBMENU_ID) else { return Ok(()) };
    for item in sub.items()? {
        sub.remove(&item)?;
    }
    fill(app, &sub, &list)
}

fn find_submenu<R: Runtime>(items: &[MenuItemKind<R>], id: &str) -> Option<Submenu<R>> {
    for it in items {
        if let MenuItemKind::Submenu(s) = it {
            if s.id().as_ref() == id {
                return Some(s.clone());
            }
            if let Some(found) = s.items().ok().and_then(|c| find_submenu(&c, id)) {
                return Some(found);
            }
        }
    }
    None
}

pub fn fill<R: Runtime>(app: &AppHandle<R>, sub: &Submenu<R>, list: &[(String, String)]) -> tauri::Result<()> {
    let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
    for (i, (label, _)) in list.iter().enumerate() {
        items.push(Box::new(MenuItem::with_id(app, format!("{ID_PREFIX}{i}"), label, true, None::<&str>)?));
    }
    if list.is_empty() {
        items.push(Box::new(MenuItem::with_id(app, "recent:none", "No Recent Items", false, None::<&str>)?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(app, ID_CLEAR, "Clear Menu", !list.is_empty(), None::<&str>)?));
    for it in &items {
        sub.append(it.as_ref())?;
    }
    Ok(())
}

/// Path for a clicked `recent:<n>` id.
pub fn path_for<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<String> {
    let i: usize = id.strip_prefix(ID_PREFIX)?.parse().ok()?;
    app.try_state::<RecentState>()?.0.lock().unwrap().get(i).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn entries_skip_missing_dupes_and_cap() {
        let d = tempfile::tempdir().unwrap();
        let mk = |n: &str| {
            let p = d.path().join(n);
            fs::write(&p, "").unwrap();
            p.to_string_lossy().into_owned()
        };
        let a = mk("a.md");
        let b = mk("b.md");
        let gone = d.path().join("gone.md").to_string_lossy().into_owned();
        let folder = d.path().to_string_lossy().into_owned();
        let e = entries(&[a.clone(), gone, b.clone(), a.clone()], &[folder.clone()], None);
        let paths: Vec<_> = e.iter().map(|x| x.1.clone()).collect();
        assert_eq!(paths, vec![a, b, folder]);
        let many: Vec<String> = (0..30).map(|i| mk(&format!("n{i}.md"))).collect();
        assert_eq!(entries(&many, &[], None).len(), MAX_ITEMS);
    }

    #[test]
    fn labels_use_tilde_and_parent() {
        let home = Path::new("/Users/me");
        assert_eq!(label(Path::new("/Users/me/notes/a.md"), Some(home)), "a.md — ~/notes");
        assert_eq!(label(Path::new("/Users/me/a.md"), Some(home)), "a.md — ~");
        assert_eq!(label(Path::new("/tmp/x.md"), Some(home)), "x.md — /tmp");
        assert_eq!(label(Path::new("/"), None), "/");
    }

    #[test]
    fn second_instance_args() {
        let d = tempfile::tempdir().unwrap();
        let cwd = d.path();
        fs::write(cwd.join("rel.md"), "").unwrap();
        fs::write(cwd.join("with space.md"), "").unwrap();
        fs::write(cwd.join("-dash.md"), "").unwrap();
        let abs = cwd.join("rel.md").to_string_lossy().into_owned();
        let uri = format!("file://{}", cwd.join("with space.md").to_string_lossy().replace(' ', "%20"));
        let args: Vec<String> = ["/usr/bin/margin", "--flag", "rel.md", "./sub/../rel.md", &abs, &uri, "missing.md", "-psn_0_123", "--", "-dash.md"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let got = paths_from_args(&args, cwd, true);
        let want = vec![cwd.join("rel.md"), cwd.join("rel.md"), cwd.join("rel.md"), cwd.join("with space.md"), cwd.join("-dash.md")];
        assert_eq!(got, want);
        assert!(paths_from_args(&["margin".into()], cwd, true).is_empty());
    }

    // muda creates native menus only on the main thread (test threads aren't); this is
    // exercised in the real app instead (see the PR's macOS run notes).
    #[test]
    #[ignore = "native menus need the main thread"]
    fn menu_is_built_and_rebuilt() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("doc.md");
        fs::write(&f, "").unwrap();
        let app = tauri::test::mock_builder().manage(RecentState::default()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let h = app.handle().clone();
        let files = vec![f.to_string_lossy().into_owned()];
        let m = crate::menu::build(&h, &["paper".into()], "paper", &entries(&files, &[], None)).unwrap();
        h.set_menu(m).unwrap();
        set_menu(&h, &files, &[]).unwrap();
        assert_eq!(path_for(&h, "recent:0").as_deref(), Some(files[0].as_str()));
        let sub = find_submenu(&h.menu().unwrap().items().unwrap(), SUBMENU_ID).unwrap();
        let ids: Vec<String> = sub.items().unwrap().iter().map(|i| i.id().as_ref().to_string()).collect();
        assert_eq!(ids.first().map(String::as_str), Some("recent:0"));
        assert_eq!(ids.last().map(String::as_str), Some(ID_CLEAR));
        set_menu(&h, &[], &[]).unwrap();
        let ids: Vec<String> = sub.items().unwrap().iter().map(|i| i.id().as_ref().to_string()).collect();
        assert_eq!(ids.first().map(String::as_str), Some("recent:none"));
        assert_eq!(path_for(&h, "recent:0"), None);
    }
}
