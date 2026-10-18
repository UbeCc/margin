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
/// File › Open Recent › Reopen Closed File (⇧⌘T), first item of the submenu.
pub const ID_REOPEN: &str = "reopenClosed";
/// Typora: at most 12 recent files and 10 recent folders (native-commands §2.1).
pub const MAX_FILES: usize = 12;
pub const MAX_FOLDERS: usize = 10;

/// Paths behind the `recent:<n>` menu ids.
#[derive(Default)]
pub struct RecentState(pub Mutex<Vec<String>>);

/// Menu entries (label, path): up to `MAX_FILES` files, then up to `MAX_FOLDERS` folders;
/// missing entries and duplicates dropped. Labels are the bare name; when two entries
/// (files or folders) share a name, every one of them becomes `name — parent`, the parent
/// abbreviated to `~/…` and the leading `~/` dropped (Typora `decideRecentMenuItemLabel`).
pub fn entries(files: &[String], folders: &[String], home: Option<&Path>) -> Vec<(String, String)> {
    let mut seen: Vec<&String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for (list, max) in [(files, MAX_FILES), (folders, MAX_FOLDERS)] {
        let mut n = 0;
        for p in list {
            if n == max {
                break;
            }
            if seen.contains(&p) || !Path::new(p).exists() {
                continue;
            }
            seen.push(p);
            out.push(p.clone());
            n += 1;
        }
    }
    let names: Vec<String> = out.iter().map(|p| name_of(Path::new(p))).collect();
    out.into_iter()
        .zip(names.iter())
        .map(|(p, name)| {
            let label = if names.iter().filter(|n| *n == name).count() > 1 { label(Path::new(&p), home) } else { name.clone() };
            (label, p)
        })
        .collect()
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

fn tilde(p: &Path, home: Option<&Path>) -> String {
    match home.and_then(|h| p.strip_prefix(h).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => rest.to_string_lossy().into_owned(), // `~/notes` shown as `notes`
        None => p.to_string_lossy().into_owned(),
    }
}

/// Disambiguated label `name — parent`.
pub fn label(p: &Path, home: Option<&Path>) -> String {
    let name = name_of(p);
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

/// Compute the entries and remember their paths for the `recent:<n>` ids (used when
/// the whole menu is built at startup).
pub fn prepare<R: Runtime>(app: &AppHandle<R>, files: &[String], folders: &[String]) -> Vec<(String, String)> {
    let home = app.path().home_dir().ok();
    let list = entries(files, folders, home.as_deref());
    if let Some(state) = app.try_state::<RecentState>() {
        *state.0.lock().unwrap() = list.iter().map(|(_, p)| p.clone()).collect();
    }
    list
}

/// Rebuild the Open Recent submenu.
pub fn set_menu<R: Runtime>(app: &AppHandle<R>, files: &[String], folders: &[String]) -> tauri::Result<()> {
    let list = prepare(app, files, folders);
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
    // Typora order: Reopen Closed File / — / files / — / folders / — / Clear Items.
    let mut items: Vec<Box<dyn IsMenuItem<R>>> = vec![
        Box::new(MenuItem::with_id(app, ID_REOPEN, "Reopen Closed File", true, Some("CmdOrCtrl+Shift+T"))?),
        Box::new(PredefinedMenuItem::separator(app)?),
    ];
    let mut prev_folder: Option<bool> = None;
    for (i, (label, path)) in list.iter().enumerate() {
        let folder = Path::new(path).is_dir();
        if prev_folder == Some(false) && folder {
            items.push(Box::new(PredefinedMenuItem::separator(app)?));
        }
        prev_folder = Some(folder);
        items.push(Box::new(MenuItem::with_id(app, format!("{ID_PREFIX}{i}"), label, true, None::<&str>)?));
    }
    if !list.is_empty() {
        items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    items.push(Box::new(MenuItem::with_id(app, ID_CLEAR, "Clear Items", !list.is_empty(), None::<&str>)?));
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

/// Main-thread check of the Open Recent submenu (muda only builds menus on the main
/// thread, so this runs from `tests/menu_main.rs` with `harness = false`).
#[doc(hidden)]
pub fn menu_selftest<R: Runtime>(h: &AppHandle<R>, file: &str) -> Result<(), String> {
    let e = |x: tauri::Error| x.to_string();
    let files = vec![file.to_string()];
    let m = crate::menu::build(h, &["paper".into()], "paper", &prepare(h, &files, &[])).map_err(e)?;
    h.set_menu(m).map_err(e)?;
    let ids = |h: &AppHandle<R>| -> Result<Vec<String>, String> {
        let sub = find_submenu(&h.menu().ok_or("no menu")?.items().map_err(e)?, SUBMENU_ID).ok_or("no Open Recent submenu")?;
        Ok(sub.items().map_err(e)?.iter().map(|i| i.id().as_ref().to_string()).collect())
    };
    // separators have generated ids: compare the named items only
    let named = |v: Vec<String>| -> Vec<String> { v.into_iter().filter(|i| i == ID_REOPEN || i == ID_CLEAR || i.starts_with(ID_PREFIX)).collect() };
    let got = ids(h)?;
    if got.len() != 5 || named(got.clone()) != [ID_REOPEN, "recent:0", ID_CLEAR] {
        return Err(format!("unexpected items {got:?}"));
    }
    if path_for(h, "recent:0").as_deref() != Some(file) {
        return Err("recent:0 does not map to the file".into());
    }
    set_menu(h, &[], &[]).map_err(e)?;
    let got = ids(h)?;
    if named(got.clone()) != [ID_REOPEN, ID_CLEAR] || path_for(h, "recent:0").is_some() {
        return Err(format!("not cleared: {got:?}"));
    }
    set_menu(h, &files, &files).map_err(e)?;
    if named(ids(h)?).len() != 3 {
        return Err("duplicate file+folder entry".into());
    }
    Ok(())
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
        let e = entries(&[a.clone(), gone, b.clone(), a.clone()], std::slice::from_ref(&folder), None);
        let paths: Vec<_> = e.iter().map(|x| x.1.clone()).collect();
        assert_eq!(paths, vec![a, b, folder]);
        let many: Vec<String> = (0..30).map(|i| mk(&format!("n{i}.md"))).collect();
        assert_eq!(entries(&many, &[], None).len(), MAX_FILES);
        let dirs: Vec<String> = (0..12)
            .map(|i| {
                let p = d.path().join(format!("dir{i}"));
                fs::create_dir(&p).unwrap();
                p.to_string_lossy().into_owned()
            })
            .collect();
        let e = entries(&many, &dirs, None);
        assert_eq!(e.len(), MAX_FILES + MAX_FOLDERS);
        assert_eq!(e[MAX_FILES].1, dirs[0]);
    }

    #[test]
    fn labels_use_tilde_and_parent() {
        let home = Path::new("/Users/me");
        assert_eq!(label(Path::new("/Users/me/notes/a.md"), Some(home)), "a.md — notes");
        assert_eq!(label(Path::new("/Users/me/a.md"), Some(home)), "a.md — ~");
        assert_eq!(label(Path::new("/tmp/x.md"), Some(home)), "x.md — /tmp");
        assert_eq!(label(Path::new("/"), None), "/");
    }

    #[test]
    fn only_same_names_are_disambiguated() {
        let d = tempfile::tempdir().unwrap();
        for sub in ["notes", "work"] {
            fs::create_dir(d.path().join(sub)).unwrap();
            fs::write(d.path().join(sub).join("todo.md"), "").unwrap();
        }
        fs::write(d.path().join("solo.md"), "").unwrap();
        let p = |r: &str| d.path().join(r).to_string_lossy().into_owned();
        let e = entries(&[p("notes/todo.md"), p("work/todo.md"), p("solo.md")], &[p("notes")], Some(d.path()));
        let labels: Vec<_> = e.iter().map(|x| x.0.as_str()).collect();
        assert_eq!(labels, ["todo.md — notes", "todo.md — work", "solo.md", "notes"]);
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

}
