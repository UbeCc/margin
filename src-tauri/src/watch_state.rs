//! Watcher event interpretation as a *state diff*.
//!
//! Raw OS events are unreliable descriptions of what happened: FSEvents coalesces
//! flags (a long-existing file can arrive as "created"), editors save through temp
//! files and backups (vim: `doc.md` → `doc.md~`, new `doc.md`; JetBrains:
//! `___jb_tmp___`/`___jb_old___`), and renames arrive as two unrelated paths. So we
//! treat events only as "these paths were touched", remember which paths existed
//! (with their file ids), and report the difference between before and now.

use crate::fsops::{self, OwnWrites};
use notify::event::{EventKind, ModifyKind, RenameMode};
use notify_debouncer_full::DebouncedEvent;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Upper bound for the remembered tree; beyond it, unknown paths fall back to the
/// raw event kind.
pub const MAX_KNOWN: usize = 200_000;

/// What is watched: a directory (recursively), or a single file (its parent
/// directory is watched non-recursively, so atomic replaces don't kill the watch).
#[derive(Clone, Debug)]
pub struct Scope {
    pub given_dir: PathBuf,
    pub canonical_dir: PathBuf,
    /// Canonical name of the watched file (events arrive under this name).
    pub file: Option<OsString>,
    /// The file name the frontend used (differs when the doc is a symlink).
    pub given_file: Option<OsString>,
}

impl Scope {
    pub fn new(root: &Path) -> Self {
        let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        if canonical.is_file()
            && let (Some(cd), Some(gd), Some(gname), Some(cname)) =
                (canonical.parent(), root.parent(), root.file_name(), canonical.file_name())
        {
            return Scope {
                given_dir: gd.to_path_buf(),
                canonical_dir: cd.to_path_buf(),
                file: Some(cname.to_os_string()),
                given_file: Some(gname.to_os_string()),
            };
        }
        Scope { given_dir: root.to_path_buf(), canonical_dir: canonical, file: None, given_file: None }
    }

    pub fn recursive(&self) -> bool {
        self.file.is_none()
    }

    fn rel<'a>(&self, p: &'a Path) -> Option<&'a Path> {
        p.strip_prefix(&self.canonical_dir).ok().or_else(|| p.strip_prefix(&self.given_dir).ok())
    }

    pub fn to_given(&self, p: &Path) -> Option<PathBuf> {
        let rel = self.rel(p)?;
        if let Some(f) = &self.file
            && rel == Path::new(f)
        {
            // map back to the frontend's file path (it may be a symlink name)
            return Some(self.given_dir.join(self.given_file.as_ref().unwrap_or(f)));
        }
        Some(if rel.as_os_str().is_empty() { self.given_dir.clone() } else { self.given_dir.join(rel) })
    }

    /// Inside the watched directory and not hidden / temporary / backup.
    pub fn candidate(&self, p: &Path) -> bool {
        match self.rel(p) {
            Some(r) if !r.as_os_str().is_empty() => !ignored_rel(r),
            _ => false,
        }
    }

    /// Events for this path are reported to the frontend.
    pub fn in_scope(&self, p: &Path) -> bool {
        match &self.file {
            None => self.candidate(p),
            Some(f) => self.rel(p) == Some(Path::new(f)),
        }
    }
}

/// Hidden components, our temp files, and other editors' temp/backup names.
pub fn ignored_rel(rel: &Path) -> bool {
    if rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
        return true;
    }
    let name = rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    is_editor_temp(&name)
}

pub fn is_editor_temp(name: &str) -> bool {
    fsops::is_temp_name(name)
        || name.ends_with('~')
        || name.ends_with("___jb_tmp___")
        || name.ends_with("___jb_old___")
        || (name.starts_with('#') && name.ends_with('#'))
        || name == "4913"
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Node {
    id: Option<(u64, u64)>,
    is_dir: bool,
    /// (mtime in ns, length): a "modified" event without a change here is a replay.
    stamp: (u128, u64),
}

fn node_of(p: &Path) -> Option<Node> {
    let m = std::fs::symlink_metadata(p).ok()?;
    #[cfg(unix)]
    let id = {
        use std::os::unix::fs::MetadataExt;
        Some((m.dev(), m.ino()))
    };
    #[cfg(not(unix))]
    let id = None;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some(Node { id, is_dir: m.is_dir(), stamp: (mtime, m.len()) })
}

fn recent(mtime_ns: u128) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    now.saturating_sub(mtime_ns) < 2_000_000_000
}

/// Paths (canonical, as the OS reports them) known to exist under the scope.
#[derive(Default)]
pub struct Known {
    map: HashMap<PathBuf, Node>,
    /// The initial scan covered everything (not capped).
    pub complete: bool,
}

impl Known {
    pub fn scan(scope: &Scope) -> Self {
        let mut k = Known { map: HashMap::new(), complete: true };
        match &scope.file {
            Some(f) => {
                let p = scope.canonical_dir.join(f);
                if let Some(n) = node_of(&p) {
                    k.map.insert(p, n);
                }
            }
            None => k.add_tree(scope, &scope.canonical_dir.clone()),
        }
        k
    }

    fn add_tree(&mut self, scope: &Scope, dir: &Path) {
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if !scope.candidate(&p) {
                    continue;
                }
                if self.map.len() >= MAX_KNOWN {
                    self.complete = false;
                    return;
                }
                if let Some(n) = node_of(&p) {
                    if n.is_dir {
                        stack.push(p.clone());
                    }
                    self.map.insert(p, n);
                }
            }
        }
    }

    /// Known paths that no longer exist and carry one of `ids` (rename sources the
    /// OS did not report; FSEvents often only reports the destination).
    pub(crate) fn vanished_with_ids(&self, ids: &[(u64, u64)]) -> Vec<(PathBuf, (u64, u64), bool)> {
        if ids.is_empty() {
            return vec![];
        }
        self.map
            .iter()
            .filter_map(|(p, n)| n.id.filter(|id| ids.contains(id)).map(|id| (p, id, n.is_dir)))
            .filter(|(p, ..)| std::fs::symlink_metadata(p).is_err())
            .map(|(p, id, d)| (p.clone(), id, d))
            .collect()
    }

    fn remove_tree(&mut self, p: &Path) {
        self.map.remove(p);
        self.map.retain(|k, _| !k.starts_with(p));
    }

    fn move_tree(&mut self, from: &Path, to: &Path) {
        let moved: Vec<(PathBuf, Node)> =
            self.map.iter().filter(|(k, _)| k.starts_with(from)).map(|(k, v)| (k.clone(), *v)).collect();
        for (k, v) in moved {
            self.map.remove(&k);
            if let Ok(rest) = k.strip_prefix(from) {
                self.map.insert(if rest.as_os_str().is_empty() { to.to_path_buf() } else { to.join(rest) }, v);
            }
        }
    }
}

#[path = "watch_state_diff.rs"]
mod diff;
pub use diff::translate;

/// Paths touched by a batch, in first-seen order, with hints from the raw events.
pub(crate) struct Touched {
    pub order: Vec<PathBuf>,
    pub created_hint: HashSet<PathBuf>,
    pub pairs: Vec<(PathBuf, PathBuf)>,
    pub time: HashMap<PathBuf, Instant>,
}

pub(crate) fn collect(events: &[DebouncedEvent], scope: &Scope) -> Touched {
    let mut t = Touched { order: vec![], created_hint: HashSet::new(), pairs: vec![], time: HashMap::new() };
    for ev in events {
        let kind = ev.event.kind;
        if matches!(kind, EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))) {
            continue;
        }
        let paths = &ev.event.paths;
        if matches!(kind, EventKind::Modify(ModifyKind::Name(RenameMode::Both))) && paths.len() == 2 {
            t.pairs.push((paths[0].clone(), paths[1].clone()));
        }
        for p in paths {
            if !scope.candidate(p) {
                continue;
            }
            if matches!(kind, EventKind::Create(_)) {
                t.created_hint.insert(p.clone());
            }
            if !t.time.contains_key(p) {
                t.order.push(p.clone());
            }
            t.time.insert(p.clone(), ev.time);
        }
    }
    t
}

pub(crate) fn own_lookup(own: &OwnWrites, p: &Path, at: Option<&Instant>) -> Option<bool> {
    own.lookup(p, at.copied().unwrap_or_else(Instant::now))
}

pub(crate) fn now_node(p: &Path) -> Option<(bool, Option<(u64, u64)>)> {
    node_of(p).map(|n| (n.is_dir, n.id))
}

impl Known {
    pub(crate) fn node(&self, p: &Path) -> Option<(bool, Option<(u64, u64)>)> {
        self.map.get(p).map(|n| (n.is_dir, n.id))
    }
    /// The file at `p` differs from what we remember (new inode, mtime or size).
    pub(crate) fn changed(&self, p: &Path) -> bool {
        match (self.map.get(p), node_of(p)) {
            // Coarse-mtime filesystems (HFS+, FAT, SMB) can hide a same-size rewrite
            // inside one tick, so a very recent mtime always counts as a change.
            (Some(a), Some(b)) => a.id != b.id || a.stamp != b.stamp || recent(b.stamp.0),
            _ => true,
        }
    }
    /// Bring the map in line with the filesystem for one touched path.
    pub(crate) fn refresh(&mut self, scope: &Scope, p: &Path) {
        match node_of(p) {
            Some(n) => {
                let new_dir = n.is_dir && !self.map.contains_key(p);
                self.map.insert(p.to_path_buf(), n);
                if new_dir && scope.recursive() {
                    self.add_tree(scope, p);
                }
            }
            None => self.remove_tree(p),
        }
    }
    pub(crate) fn renamed(&mut self, from: &Path, to: &Path) {
        self.move_tree(from, to);
    }
}
