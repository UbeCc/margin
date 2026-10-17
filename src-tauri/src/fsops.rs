//! Plain filesystem primitives (no Tauri types here so they are unit-testable).

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// Mirrors `DirEntry` in `src/contracts.ts`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub mtime: f64,
    pub size: u64,
}

/// Prefix of temp files created by [`atomic_write`]; the watcher drops events for them.
pub const TEMP_PREFIX: &str = ".margin-";
pub const TEMP_SUFFIX: &str = ".tmp";

pub fn is_temp_name(name: &str) -> bool {
    name.starts_with(TEMP_PREFIX) && name.ends_with(TEMP_SUFFIX)
}

pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

pub fn entry_for(path: &Path) -> std::io::Result<DirEntry> {
    let meta = fs::metadata(path)?; // follows symlinks
    Ok(DirEntry {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_str(path)),
        path: path_str(path),
        is_dir: meta.is_dir(),
        mtime: mtime_ms(&meta),
        size: if meta.is_dir() { 0 } else { meta.len() },
    })
}

pub fn stat(path: &Path) -> Option<DirEntry> {
    entry_for(path).ok()
}

/// Read a text file as UTF-8. A UTF-8 BOM is stripped; UTF-16 (with BOM) is decoded;
/// anything else that is not valid UTF-8 is decoded lossily.
pub fn read_text(path: &Path) -> std::io::Result<String> {
    let bytes = fs::read(path)?;
    Ok(decode_text(&bytes))
}

pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    let utf16 = |rest: &[u8], le: bool| {
        let units: Vec<u16> = rest
            .as_chunks::<2>().0.iter()
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, true);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, false);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Atomically replace `path` with `data`: write a temp file in the same directory,
/// fsync, copy the old file's permissions, then rename over the target.
/// If `path` is a symlink the *link target* is replaced, keeping the link intact.
/// Returns whether the file existed before.
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<bool> {
    let target: PathBuf = match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let existing = fs::metadata(&target).ok();
    let mut tmp = tempfile::Builder::new()
        .prefix(TEMP_PREFIX)
        .suffix(TEMP_SUFFIX)
        .tempfile_in(&dir)?;
    tmp.write_all(data)?;
    tmp.as_file().sync_all()?;
    if let Some(meta) = &existing {
        // tempfile creates 0600 files; restore the original mode (and readonly flag on Windows).
        fs::set_permissions(tmp.path(), meta.permissions())?;
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // A new file gets the conventional 0644 (umask is not consulted by tempfile).
            fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o644))?;
        }
    }
    tmp.persist(&target).map_err(|e| e.error)?;
    Ok(existing.is_some())
}

/// Children of a directory: hidden entries (dot files) and our temp files filtered,
/// directories first, then case-insensitive natural-ish name order.
/// `rename` that refuses to replace an existing destination (std's rename overwrites files).
/// A case-only rename of the same item (`a.md` → `A.md` on a case-insensitive volume) is allowed.
pub fn rename_no_clobber(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "source does not exist"));
    }
    if to.exists() {
        let same = fs::canonicalize(from).ok() == fs::canonicalize(to).ok();
        if !same {
            return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "destination already exists"));
        }
    }
    if to.starts_with(from) && to != from {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "cannot move a folder into itself"));
    }
    fs::rename(from, to)
}

/// Move to the Trash. macOS: NSFileManager; Linux: `gio trash`; elsewhere unsupported.
pub fn trash(path: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(path).is_err() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "does not exist"));
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path_str(path)));
        let fm = NSFileManager::defaultManager();
        return fm
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|e| std::io::Error::other(e.localizedDescription().to_string()));
    }
    #[cfg(target_os = "linux")]
    {
        let st = std::process::Command::new("gio").arg("trash").arg(path).status()?;
        return if st.success() { Ok(()) } else { Err(std::io::Error::other("gio trash failed")) };
    }
    #[allow(unreachable_code)]
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "unsupported: Move to Trash on this platform"))
}

pub fn list_dir(path: &Path) -> std::io::Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    for item in fs::read_dir(path)? {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || is_hidden_os(&item.path()) {
            continue;
        }
        match entry_for(&item.path()) {
            Ok(e) => out.push(e),
            Err(_) => continue, // broken symlink etc.
        }
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_cmp(&a.name.to_lowercase(), &b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

#[cfg(windows)]
fn is_hidden_os(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    fs::metadata(p).map(|m| m.file_attributes() & 0x2 != 0).unwrap_or(false)
}
#[cfg(not(windows))]
fn is_hidden_os(_p: &Path) -> bool {
    false
}

/// Compare strings treating digit runs as numbers ("note2" < "note10").
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(|c| c.is_ascii_digit()) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(|c| c.is_ascii_digit()) {
                    nb.push(c);
                    bi.next();
                }
                let ta = na.trim_start_matches('0');
                let tb = nb.trim_start_matches('0');
                let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ai.next();
                bi.next();
            }
        }
    }
}

/// Remembers paths we wrote ourselves so the watcher can drop the echo.
#[derive(Default)]
pub struct OwnWrites {
    inner: Mutex<HashMap<PathBuf, (Instant, bool)>>,
}

pub const OWN_WRITE_WINDOW: Duration = Duration::from_millis(300);

impl OwnWrites {
    pub fn record(&self, path: &Path, existed: bool) {
        let mut m = self.inner.lock().unwrap();
        let now = Instant::now();
        m.retain(|_, (t, _)| now.duration_since(*t) < Duration::from_secs(5));
        m.insert(normalize_key(path), (now, existed));
    }

    /// If `path` was written by us shortly before `at`, returns `Some(existed_before)`.
    pub fn lookup(&self, path: &Path, at: Instant) -> Option<bool> {
        let m = self.inner.lock().unwrap();
        let (t, existed) = m.get(&normalize_key(path))?;
        // `at` may be slightly before our timestamp (event raised while renaming).
        let delta = if at >= *t { at - *t } else { *t - at };
        (delta <= OWN_WRITE_WINDOW).then_some(*existed)
    }
}

/// FSEvents reports canonical paths (/private/var/... for /var/...); compare canonicalized.
pub fn normalize_key(p: &Path) -> PathBuf {
    if let Ok(c) = fs::canonicalize(p) {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => fs::canonicalize(parent)
            .map(|d| d.join(name))
            .unwrap_or_else(|_| p.to_path_buf()),
        _ => p.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        assert!(!atomic_write(&p, b"one").unwrap());
        assert_eq!(fs::read_to_string(&p).unwrap(), "one");
        assert!(atomic_write(&p, "two ✓".as_bytes()).unwrap());
        assert_eq!(fs::read_to_string(&p).unwrap(), "two ✓");
        // no temp files left behind
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("script.md");
        fs::write(&p, "x").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o750)).unwrap();
        atomic_write(&p, b"y").unwrap();
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o750);
        let q = dir.path().join("new.md");
        atomic_write(&q, b"y").unwrap();
        assert_eq!(fs::metadata(&q).unwrap().permissions().mode() & 0o777, 0o644);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        atomic_write(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }

    #[test]
    fn decode_variants() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFhi"), "hi");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]), "hi");
        assert_eq!(decode_text(b"caf\xE9"), "caf\u{FFFD}");
    }

    #[test]
    fn list_dir_sorts_and_filters() {
        let dir = tempfile::tempdir().unwrap();
        for n in ["b.md", "a10.md", "a2.md", ".hidden", "B.txt"] {
            fs::write(dir.path().join(n), "").unwrap();
        }
        fs::create_dir(dir.path().join("zdir")).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let names: Vec<_> = list_dir(dir.path()).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["zdir", "a2.md", "a10.md", "b.md", "B.txt"]);
    }

    #[test]
    fn own_writes_window() {
        let ow = OwnWrites::default();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.md");
        fs::write(&p, "").unwrap();
        ow.record(&p, true);
        assert_eq!(ow.lookup(&p, Instant::now()), Some(true));
        assert_eq!(ow.lookup(&p, Instant::now() + Duration::from_secs(2)), None);
    }
}
