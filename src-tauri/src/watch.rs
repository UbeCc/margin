//! Recursive, debounced folder watching. Raw notify events are translated to the
//! frontend's `FsEvent` shape, filtered (hidden paths, our temp files, echoes of our
//! own writes) and delivered in batches.

use crate::fsops::{self, OwnWrites};
use notify::event::{EventKind, ModifyKind, RenameMode};
use notify_debouncer_full::{DebouncedEvent, Debouncer, RecommendedCache, new_debouncer};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const DEBOUNCE: Duration = Duration::from_millis(200);

/// Mirrors `FsEvent` in `src/contracts.ts`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FsEvent {
    Created { path: String },
    Removed { path: String },
    Modified { path: String },
    Renamed { from: String, to: String },
}

pub struct Watch {
    pub root: PathBuf,
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

/// Maps between the canonical root (what the OS reports) and the root string the
/// frontend gave us, so emitted paths stay in the frontend's namespace.
#[derive(Clone)]
pub struct RootMap {
    pub given: PathBuf,
    pub canonical: PathBuf,
}

impl RootMap {
    pub fn new(given: &Path) -> Self {
        let canonical = std::fs::canonicalize(given).unwrap_or_else(|_| given.to_path_buf());
        RootMap { given: given.to_path_buf(), canonical }
    }
    fn rel<'a>(&self, p: &'a Path) -> Option<&'a Path> {
        p.strip_prefix(&self.canonical).ok().or_else(|| p.strip_prefix(&self.given).ok())
    }
    fn to_given(&self, p: &Path) -> Option<PathBuf> {
        self.rel(p).map(|r| if r.as_os_str().is_empty() { self.given.clone() } else { self.given.join(r) })
    }
    fn hidden(&self, p: &Path) -> bool {
        match self.rel(p) {
            Some(r) => r.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')),
            None => true, // outside root
        }
    }
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Translate one debounced batch. Pure apart from `exists()` checks.
pub fn translate(events: &[DebouncedEvent], root: &RootMap, own: &OwnWrites) -> Vec<FsEvent> {
    let mut out: Vec<FsEvent> = Vec::new();
    let s = |p: &Path| root.to_given(p).map(|g| fsops::path_str(&g));
    // An event for a path we just wrote: drop it if the file existed (pure echo),
    // turn it into `created` if our write created the file (Save As into a folder).
    let own_or = |p: &Path, ev: &DebouncedEvent, otherwise: FsEvent| -> Option<FsEvent> {
        match own.lookup(p, ev.time) {
            Some(true) => None,
            Some(false) => s(p).map(|path| FsEvent::Created { path }),
            None => Some(otherwise),
        }
    };
    for ev in events {
        let paths = &ev.event.paths;
        let mut push = |e: Option<FsEvent>| {
            if let Some(e) = e {
                if !out.contains(&e) {
                    out.push(e);
                }
            }
        };
        match ev.event.kind {
            EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_)) => {}
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if paths.len() == 2 => {
                let (from, to) = (&paths[0], &paths[1]);
                if root.hidden(to) {
                    if !root.hidden(from) {
                        push(s(from).map(|path| FsEvent::Removed { path }));
                    }
                    continue;
                }
                if root.hidden(from) || fsops::is_temp_name(&name_of(from)) {
                    // atomic save by us or another app: temp → target
                    let Some(path) = s(to) else { continue };
                    push(own_or(to, ev, FsEvent::Modified { path }));
                    continue;
                }
                if let (Some(f), Some(t)) = (s(from), s(to)) {
                    push(Some(FsEvent::Renamed { from: f, to: t }));
                }
            }
            _ => {
                for p in paths {
                    if root.hidden(p) || fsops::is_temp_name(&name_of(p)) {
                        continue;
                    }
                    let Some(path) = s(p) else { continue };
                    let e = match ev.event.kind {
                        EventKind::Create(_) => FsEvent::Created { path },
                        EventKind::Remove(_) => FsEvent::Removed { path },
                        EventKind::Modify(ModifyKind::Name(_)) => {
                            if p.exists() { FsEvent::Created { path } } else { FsEvent::Removed { path } }
                        }
                        _ => {
                            if p.exists() { FsEvent::Modified { path } } else { FsEvent::Removed { path } }
                        }
                    };
                    let e = match e {
                        FsEvent::Removed { .. } => Some(e),
                        other => own_or(p, ev, other),
                    };
                    push(e);
                }
            }
        }
    }
    // A file both created and modified in one batch → just "created".
    let created: Vec<String> = out
        .iter()
        .filter_map(|e| if let FsEvent::Created { path } = e { Some(path.clone()) } else { None })
        .collect();
    out.retain(|e| !matches!(e, FsEvent::Modified { path } if created.contains(path)));
    out
}

pub fn start(
    root: &Path,
    own: Arc<OwnWrites>,
    deliver: impl Fn(Vec<FsEvent>) + Send + 'static,
) -> Result<Watch, String> {
    let map = RootMap::new(root);
    let map2 = map.clone();
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: notify_debouncer_full::DebounceEventResult| {
        if let Ok(events) = res {
            let batch = translate(&events, &map2, &own);
            if !batch.is_empty() {
                deliver(batch);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watch(&map.canonical, notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    Ok(Watch { root: root.to_path_buf(), _debouncer: debouncer })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, Event};
    use std::time::Instant;

    fn ev(kind: EventKind, paths: &[&Path]) -> DebouncedEvent {
        let mut e = Event::new(kind);
        for p in paths {
            e = e.add_path(p.to_path_buf());
        }
        DebouncedEvent::new(e, Instant::now())
    }

    #[test]
    fn translates_and_filters() {
        let dir = tempfile::tempdir().unwrap();
        let root = RootMap::new(dir.path());
        let c = &root.canonical;
        std::fs::write(c.join("a.md"), "").unwrap();
        std::fs::write(c.join("mine.md"), "").unwrap();
        let own = OwnWrites::default();
        own.record(&c.join("mine.md"), true);
        let events = vec![
            ev(EventKind::Create(CreateKind::File), &[&c.join("a.md")]),
            ev(EventKind::Modify(ModifyKind::Data(DataChange::Content)), &[&c.join("a.md")]),
            ev(EventKind::Create(CreateKind::File), &[&c.join(".git/index")]),
            ev(EventKind::Create(CreateKind::File), &[&c.join(".margin-abc.tmp")]),
            ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &[&c.join(".margin-abc.tmp"), &c.join("mine.md")]),
            ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &[&c.join("x.md"), &c.join("y.md")]),
            ev(EventKind::Remove(notify::event::RemoveKind::File), &[&c.join("gone.md")]),
        ];
        let out = translate(&events, &root, &own);
        let g = |n: &str| dir.path().join(n).to_string_lossy().into_owned();
        assert_eq!(
            out,
            vec![
                FsEvent::Created { path: g("a.md") },
                FsEvent::Renamed { from: g("x.md"), to: g("y.md") },
                FsEvent::Removed { path: g("gone.md") },
            ]
        );
    }

    #[test]
    fn own_write_of_new_file_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let root = RootMap::new(dir.path());
        let c = &root.canonical;
        std::fs::write(c.join("new.md"), "").unwrap();
        let own = OwnWrites::default();
        own.record(&c.join("new.md"), false);
        let events = vec![ev(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &[&c.join(".margin-x.tmp"), &c.join("new.md")],
        )];
        let out = translate(&events, &root, &own);
        assert_eq!(out, vec![FsEvent::Created { path: dir.path().join("new.md").to_string_lossy().into_owned() }]);
    }

    #[test]
    fn live_watch_reports_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let own = Arc::new(OwnWrites::default());
        let _w = start(dir.path(), own.clone(), move |b| {
            let _ = tx.send(b);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(dir.path().join("ext.md"), "hi").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.extend(b);
            }
            if seen.iter().any(|e| matches!(e, FsEvent::Created { path } if path.ends_with("ext.md"))) {
                break;
            }
        }
        assert!(
            seen.iter().any(|e| matches!(e, FsEvent::Created { path } | FsEvent::Modified { path } if path.ends_with("ext.md"))),
            "{seen:?}"
        );
    }
}
