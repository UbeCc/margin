//! Recursive, debounced folder watching. Raw notify events are translated to the
//! frontend's `FsEvent` shape, filtered (hidden paths, our temp files, echoes of our
//! own writes) and delivered in batches.

use crate::fsops::OwnWrites;
use crate::watch_state::{Known, Scope, translate};
use notify_debouncer_full::{Debouncer, RecommendedCache, new_debouncer};
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

pub fn start(
    root: &Path,
    own: Arc<OwnWrites>,
    deliver: impl Fn(Vec<FsEvent>) + Send + 'static,
) -> Result<Watch, String> {
    let scope = Scope::new(root);
    // Snapshot what exists *before* watching, so later events can be diffed.
    let mut known = Known::scan(&scope);
    let scope2 = scope.clone();
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: notify_debouncer_full::DebounceEventResult| {
        if let Ok(events) = res {
            let batch = translate(&events, &scope2, &mut known, &own);
            if !batch.is_empty() {
                deliver(batch);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    let dir = &scope.canonical_dir;
    let mode = if scope.recursive() { notify::RecursiveMode::Recursive } else { notify::RecursiveMode::NonRecursive };
    if let Err(e) = debouncer.watch(dir, mode) {
        if !is_watch_limit(&e) || !scope.recursive() {
            return Err(if is_watch_limit(&e) { watch_limit_message(dir) } else { e.to_string() });
        }
        // Linux: a big tree can exhaust fs.inotify.max_user_watches. Degrade to
        // watching just the top level rather than failing the folder open.
        log::warn!("{}", watch_limit_message(dir));
        let _ = debouncer.unwatch(dir);
        debouncer
            .watch(dir, notify::RecursiveMode::NonRecursive)
            .map_err(|e| if is_watch_limit(&e) { watch_limit_message(dir) } else { e.to_string() })?;
    }
    Ok(Watch { root: root.to_path_buf(), _debouncer: debouncer })
}

/// inotify watch/instance limits surface as `MaxFilesWatch` or as ENOSPC/EMFILE.
pub fn is_watch_limit(e: &notify::Error) -> bool {
    match &e.kind {
        notify::ErrorKind::MaxFilesWatch => true,
        notify::ErrorKind::Io(io) => matches!(io.raw_os_error(), Some(28) | Some(24)),
        _ => false,
    }
}

pub fn watch_limit_message(root: &Path) -> String {
    format!(
        "watch-limit: the OS file watch limit was reached while watching {} recursively; \
         changes in subfolders won't be detected. On Linux raise it with \
         `sudo sysctl fs.inotify.max_user_watches=524288` (persist in /etc/sysctl.d/).",
        root.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn recognises_watch_limits() {
        assert!(is_watch_limit(&notify::Error::new(notify::ErrorKind::MaxFilesWatch)));
        assert!(is_watch_limit(&notify::Error::io(std::io::Error::from_raw_os_error(28))));
        assert!(!is_watch_limit(&notify::Error::path_not_found()));
        assert!(watch_limit_message(Path::new("/x")).starts_with("watch-limit:"));
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
