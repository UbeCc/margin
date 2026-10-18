//! The before/after diff for one debounced batch (see `watch_state.rs`).

use super::{Known, Scope, collect, now_node, own_lookup};
use crate::fsops::{self, OwnWrites};
use crate::watch::FsEvent;
use notify_debouncer_full::DebouncedEvent;
use std::path::PathBuf;

enum Change {
    Created(PathBuf),
    Removed(PathBuf, Option<(u64, u64)>, bool),
    Modified(PathBuf),
    Renamed(PathBuf, PathBuf),
}

/// Translate one batch and update `known`.
pub fn translate(events: &[DebouncedEvent], scope: &Scope, known: &mut Known, own: &OwnWrites) -> Vec<FsEvent> {
    if std::env::var_os("MARGIN_WATCH_DEBUG").is_some() {
        let raw: Vec<_> = events.iter().map(|e| (e.event.kind, e.event.paths.clone())).collect();
        eprintln!("margin watch raw: {raw:?}");
    }
    let t = collect(events, scope);
    let mut changes: Vec<Change> = Vec::new();
    for p in &t.order {
        let before = known.node(p);
        let existed = before.is_some() || (!known.complete && !t.created_hint.contains(p));
        match (existed, now_node(p)) {
            (true, Some((is_dir, _))) => {
                if !is_dir && known.changed(p) {
                    changes.push(Change::Modified(p.clone()));
                }
            }
            (false, Some(_)) => changes.push(Change::Created(p.clone())),
            (true, None) => {
                let (is_dir, id) = before.unwrap_or((false, None));
                changes.push(Change::Removed(p.clone(), id, is_dir));
            }
            (false, None) => {}
        }
    }

    // Rename sources the OS never mentioned: a created path whose file id belongs to
    // a known path that has vanished.
    let new_ids: Vec<(u64, u64)> = changes
        .iter()
        .filter_map(|c| if let Change::Created(p) = c { now_node(p).and_then(|n| n.1) } else { None })
        .collect();
    for (p, id, is_dir) in known.vanished_with_ids(&new_ids) {
        if !changes.iter().any(|c| matches!(c, Change::Removed(q, ..) if *q == p)) {
            changes.push(Change::Removed(p, Some(id), is_dir));
        }
    }

    // Pair removals with creations: explicit rename events first, then file ids.
    let mut paired: Vec<(usize, usize)> = Vec::new();
    let created_idx = |c: &[Change], path: &PathBuf| {
        c.iter().position(|x| matches!(x, Change::Created(q) if q == path))
    };
    for (from, to) in &t.pairs {
        let ri = changes.iter().position(|x| matches!(x, Change::Removed(q, ..) if q == from));
        if let (Some(ri), Some(ci)) = (ri, created_idx(&changes, to)) {
            paired.push((ri, ci));
        }
    }
    for ri in 0..changes.len() {
        let Change::Removed(_, Some(id), is_dir) = &changes[ri] else { continue };
        if paired.iter().any(|(r, _)| *r == ri) {
            continue;
        }
        let hit = changes.iter().enumerate().position(|(ci, x)| {
            matches!(x, Change::Created(q) if now_node(q) == Some((*is_dir, Some(*id))))
                && !paired.iter().any(|(_, c)| *c == ci)
        });
        if let Some(ci) = hit {
            paired.push((ri, ci));
        }
    }
    let mut drop_idx: Vec<usize> = Vec::new();
    for (ri, ci) in &paired {
        let (Change::Removed(from, ..), Change::Created(to)) = (&changes[*ri], &changes[*ci]) else { continue };
        let r = Change::Renamed(from.clone(), to.clone());
        drop_idx.push(*ci);
        changes[*ri] = r;
    }

    let mut out: Vec<FsEvent> = Vec::new();
    let given = |p: &PathBuf| scope.to_given(p).map(|g| fsops::path_str(&g));
    for (i, c) in changes.iter().enumerate() {
        if drop_idx.contains(&i) {
            continue;
        }
        let ev = match c {
            Change::Renamed(from, to) => {
                known.renamed(from, to);
                match (scope.in_scope(from), scope.in_scope(to)) {
                    (false, false) => None,
                    // a watched file renamed to a sibling: the document follows it
                    (true, false) if scope.file.is_some() && scope.candidate(to) => match (given(from), given(to)) {
                        (Some(from), Some(to)) => Some(FsEvent::Renamed { from, to }),
                        _ => None,
                    },
                    (true, false) => given(from).map(|path| FsEvent::Removed { path }),
                    (false, true) if scope.file.is_some() => given(to).map(|path| FsEvent::Modified { path }),
                    (false, true) => given(to).map(|path| FsEvent::Created { path }),
                    (true, true) => match (given(from), given(to)) {
                        (Some(from), Some(to)) => Some(FsEvent::Renamed { from, to }),
                        _ => None,
                    },
                }
            }
            Change::Created(p) => {
                known.refresh(scope, p);
                if !scope.in_scope(p) || own_lookup(own, p, t.time.get(p)) == Some(true) {
                    None
                } else {
                    given(p).map(|path| FsEvent::Created { path })
                }
            }
            Change::Modified(p) => {
                known.refresh(scope, p);
                if !scope.in_scope(p) || own_lookup(own, p, t.time.get(p)).is_some() {
                    None
                } else {
                    given(p).map(|path| FsEvent::Modified { path })
                }
            }
            Change::Removed(p, ..) => {
                known.refresh(scope, p);
                if scope.in_scope(p) { given(p).map(|path| FsEvent::Removed { path }) } else { None }
            }
        };
        if let Some(e) = ev
            && !out.contains(&e)
        {
            out.push(e);
        }
    }
    out
}
