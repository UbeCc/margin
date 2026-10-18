//! Quick Open: a cached file index per root (built with the `ignore` walker, so
//! `.gitignore`/hidden files are respected) plus a small fuzzy scorer.
//!
//! On macOS a Spotlight fast path (`spotlight_macos.rs`) races a background
//! re-walk when the index is stale and the root is slow to walk (last walk ≥
//! `SPOTLIGHT_MIN_WALK`). Spotlight hits are filtered with the walker's rules,
//! merged/deduped with the stale index, and ranked by the same scorer; if the
//! walk finishes first, or the folder is unindexed / the query fails, the fresh
//! walker index answers instead.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
#[path = "spotlight_macos.rs"]
pub mod spotlight_macos;

pub const MAX_INDEX: usize = 50_000;
/// Unwatched roots are re-walked when the cached index is older than this.
pub const UNWATCHED_TTL: Duration = Duration::from_secs(10);
const SKIP_DIRS: &[&str] = &["node_modules", "target", "__pycache__"];

pub fn is_markdown(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".txt"].iter().any(|e| lower.ends_with(e))
}

pub struct Index {
    /// Paths relative to root, with forward slashes.
    pub files: Vec<String>,
    pub built: Instant,
    pub dirty: bool,
}

pub fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| {
            !(e.file_type().is_some_and(|t| t.is_dir())
                && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref()))
        })
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
            if out.len() >= MAX_INDEX {
                break;
            }
        }
    }
    out
}

pub struct QuickOpen {
    indexes: Arc<Mutex<HashMap<PathBuf, Index>>>,
    /// Roots with a background walk in flight.
    building: Arc<Mutex<HashSet<PathBuf>>>,
    /// Duration of the last completed walk per root.
    walk_times: Arc<Mutex<HashMap<PathBuf, Duration>>>,
    /// Race Spotlight against a stale-index re-walk when the root's last walk
    /// took at least this long (an unwalked root counts as zero). `None`
    /// disables Spotlight; ignored off macOS.
    pub spotlight_after: Option<Duration>,
}

/// Default `spotlight_after`: an indexed MDQuery costs ~200 ms on this class of
/// machine regardless of folder size, while warm walks of a 20k-file folder take
/// ~60 ms (see `quick_open_bench.rs`), so only slow-walking roots benefit.
pub const SPOTLIGHT_MIN_WALK: Duration = Duration::from_millis(250);

impl Default for QuickOpen {
    fn default() -> Self {
        let mut qo = Self::with_spotlight(false);
        if cfg!(target_os = "macos") {
            qo.spotlight_after = Some(SPOTLIGHT_MIN_WALK);
        }
        qo
    }
}

impl QuickOpen {
    /// `true` races Spotlight on every stale search (tests/benchmarks).
    pub fn with_spotlight(spotlight: bool) -> Self {
        Self {
            indexes: Default::default(),
            building: Default::default(),
            walk_times: Default::default(),
            spotlight_after: spotlight.then_some(Duration::ZERO),
        }
    }

    fn timed_walk(walk_times: &Mutex<HashMap<PathBuf, Duration>>, root: &Path) -> Vec<String> {
        let t = Instant::now();
        let files = walk(root);
        walk_times.lock().unwrap().insert(root.to_path_buf(), t.elapsed());
        files
    }

    fn wants_spotlight(&self, root: &Path) -> bool {
        let last = self.walk_times.lock().unwrap().get(root).copied().unwrap_or_default();
        self.spotlight_after.is_some_and(|min| last >= min)
    }

    fn is_stale(&self, root: &Path, watched: bool) -> bool {
        match self.indexes.lock().unwrap().get(root) {
            None => true,
            Some(ix) => ix.dirty || (!watched && ix.built.elapsed() > UNWATCHED_TTL),
        }
    }

    fn walking(&self, root: &Path) -> bool {
        self.building.lock().unwrap().contains(root)
    }

    pub fn search(&self, root: &Path, query: &str, limit: usize, watched: bool) -> Vec<String> {
        let fuzzy = query.chars().any(|c| !c.is_whitespace());
        let race = fuzzy && self.is_stale(root, watched) && self.wants_spotlight(root);
        if let Some(rx) = race.then(|| spotlight_spawn(root, query)).flatten() {
            // Race Spotlight against a background re-walk; take whichever
            // answers first (only for roots whose walks are slow).
            self.refresh_in_background(root);
            loop {
                match rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(Some(hits)) => {
                        let cached = self.indexes.lock().unwrap().get(root).map(|ix| ix.files.clone());
                        return rank(&merge(&cached.unwrap_or_default(), hits), query, limit)
                            .into_iter()
                            .map(|rel| root.join(rel).to_string_lossy().into_owned())
                            .collect();
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) if self.walking(root) => {}
                    _ => break, // Spotlight declined/failed, or the walk finished first
                }
            }
            while self.walking(root) {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let mut map = self.indexes.lock().unwrap();
        let stale = match map.get(root) {
            None => true,
            Some(ix) => ix.dirty || (!watched && ix.built.elapsed() > UNWATCHED_TTL),
        };
        if stale {
            drop(map);
            let files = Self::timed_walk(&self.walk_times, root); // walk without holding the lock
            map = self.indexes.lock().unwrap();
            map.insert(root.to_path_buf(), Index { files, built: Instant::now(), dirty: false });
        }
        let ix = map.get(root).unwrap();
        rank(&ix.files, query, limit)
            .into_iter()
            .map(|rel| root.join(rel).to_string_lossy().into_owned())
            .collect()
    }

    /// Apply watcher events to every cached index containing the path.
    pub fn on_created(&self, path: &Path, is_dir: bool) {
        self.update(path, |files, rel| {
            if is_dir {
                return false; // unknown contents: rebuild lazily
            }
            if !files.iter().any(|f| f == rel) && !rel.split('/').any(|c| c.starts_with('.')) {
                files.push(rel.to_string());
            }
            true
        });
    }

    pub fn on_removed(&self, path: &Path) {
        self.update(path, |files, rel| {
            let prefix = format!("{rel}/");
            files.retain(|f| f != rel && !f.starts_with(&prefix));
            true
        });
    }

    fn refresh_in_background(&self, root: &Path) {
        if !self.building.lock().unwrap().insert(root.to_path_buf()) {
            return;
        }
        let (indexes, building, owned) = (self.indexes.clone(), self.building.clone(), root.to_path_buf());
        let walk_times = self.walk_times.clone();
        let spawned = std::thread::Builder::new().name("quick-open-walk".into()).spawn(move || {
            let files = Self::timed_walk(&walk_times, &owned);
            indexes.lock().unwrap().insert(owned.clone(), Index { files, built: Instant::now(), dirty: false });
            building.lock().unwrap().remove(&owned);
        });
        if spawned.is_err() {
            self.building.lock().unwrap().remove(root);
        }
    }

    pub fn forget(&self, root: &Path) {
        self.indexes.lock().unwrap().remove(root);
    }

    fn update(&self, path: &Path, f: impl Fn(&mut Vec<String>, &str) -> bool) {
        let mut map = self.indexes.lock().unwrap();
        for (root, ix) in map.iter_mut() {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if rel.is_empty() || !f(&mut ix.files, &rel) {
                    ix.dirty = true;
                }
            }
        }
    }
}

// ------------------------------------------------------------ spotlight glue

/// Cap on raw Spotlight hits per query; the scorer ranks within these.
pub const SPOTLIGHT_MAX: usize = 20_000;
/// How long an "is this folder indexed?" probe answer is trusted.
const PROBE_TTL: Duration = Duration::from_secs(60);

/// Escape a literal for a double-quoted MDQuery string value. `*` and `?` are
/// wildcards there, `\` and `"` delimit; all are backslash-escaped.
pub fn md_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '"' | '*' | '?') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// MDQuery predicate: file name contains the query's characters in order
/// (`*a*b*c*`, case/diacritic-insensitive). The substring `*abc*` is a subset,
/// and this is what the fuzzy scorer accepts inside a file name. Whitespace is
/// ignored like in `rank`; `None` for an empty query (a lone `*` name pattern
/// matches nothing in MDQuery).
///
/// Markdown extensions are enforced afterwards by `filter_hits` rather than
/// with `kMDItemFSName == "*.md"c || …` clauses: each suffix clause is another
/// scan of the volume-wide name index (measured: six of them double the query
/// time, ~200 ms → ~420 ms on a 20k-file folder).
pub fn md_predicate(query: &str) -> Option<String> {
    let mut pat = String::from("*");
    for c in query.chars().filter(|c| !c.is_whitespace()) {
        pat.push_str(&md_escape(&c.to_string()));
        pat.push('*');
    }
    (pat != "*").then(|| format!("kMDItemFSName == \"{pat}\"cd"))
}

/// Predicate used to probe whether a folder is in the Spotlight index at all:
/// any item at all under the scope. (A bare `kMDItemFSName == "*"` matches
/// nothing in MDQuery, so use the content-type tree.)
pub const PROBE_PREDICATE: &str = "kMDItemContentTypeTree == \"public.item\"";

/// Map absolute Spotlight paths to root-relative forward-slash paths, keeping
/// only files the walker would also index (no hidden components, no skipped
/// dirs, not git-ignored).
pub fn filter_hits(root: &Path, hits: Vec<PathBuf>) -> Vec<String> {
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut ignores = IgnoreCache::default();
    let mut out = Vec::new();
    for hit in hits {
        let hit = hit.canonicalize().unwrap_or(hit);
        let Ok(rel) = hit.strip_prefix(&canon).or_else(|_| hit.strip_prefix(root)) else { continue };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        if rel_s.is_empty()
            || !is_markdown(&rel_s)
            || rel_s.split('/').any(|c| c.starts_with('.') || SKIP_DIRS.contains(&c))
            || ignores.ignored(&canon, rel)
        {
            continue;
        }
        out.push(rel_s);
    }
    out
}

/// Lazily loaded `.gitignore`/`.ignore` matchers per directory under a root.
#[derive(Default)]
struct IgnoreCache {
    dirs: HashMap<PathBuf, Option<ignore::gitignore::Gitignore>>,
}

impl IgnoreCache {
    fn matcher(&mut self, dir: &Path, is_root: bool) -> Option<&ignore::gitignore::Gitignore> {
        self.dirs
            .entry(dir.to_path_buf())
            .or_insert_with(|| {
                let mut b = ignore::gitignore::GitignoreBuilder::new(dir);
                let mut any = false;
                let mut files = vec![dir.join(".gitignore"), dir.join(".ignore")];
                if is_root {
                    files.push(dir.join(".git/info/exclude"));
                }
                for f in files {
                    if f.is_file() {
                        any |= b.add(f).is_none();
                    }
                }
                if any { b.build().ok() } else { None }
            })
            .as_ref()
    }

    /// Deepest matching rule wins (a nested `!keep.md` overrides a parent).
    fn ignored(&mut self, root: &Path, rel: &Path) -> bool {
        let full = root.join(rel);
        let mut dirs = vec![root.to_path_buf()];
        let comps: Vec<_> = rel.components().collect();
        for c in &comps[..comps.len().saturating_sub(1)] {
            let next = dirs.last().unwrap().join(c);
            dirs.push(next);
        }
        for (i, dir) in dirs.iter().enumerate().rev() {
            if let Some(m) = self.matcher(dir, i == 0) {
                let r = m.matched_path_or_any_parents(&full, false);
                if r.is_ignore() {
                    return true;
                }
                if r.is_whitelist() {
                    return false;
                }
            }
        }
        false
    }
}

/// Union of the cached walker index and Spotlight hits, deduped by relative
/// path (both sides are relative to the same canonical root).
pub fn merge(cached: &[String], hits: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = cached.iter().cloned().collect();
    let mut out = cached.to_vec();
    for h in hits {
        if seen.insert(h.clone()) {
            out.push(h);
        }
    }
    out
}

#[cfg(target_os = "macos")]
static UNINDEXED: std::sync::OnceLock<Mutex<HashMap<PathBuf, Instant>>> = std::sync::OnceLock::new();

/// Filtered, root-relative Spotlight hits (blocking), or `None` → use the
/// walker. An empty answer is ambiguous (no match vs. folder not indexed), so it
/// is also `None`; a probe then decides whether to skip Spotlight for this
/// folder for `PROBE_TTL`.
#[cfg(target_os = "macos")]
pub fn spotlight_hits(root: &Path, query: &str) -> Option<Vec<String>> {
    let canon = root.canonicalize().ok()?;
    let hits = spotlight_macos::query_blocking(&canon, &md_predicate(query)?, SPOTLIGHT_MAX)?;
    if hits.is_empty() {
        let indexed = spotlight_macos::query_blocking(&canon, PROBE_PREDICATE, 1).is_some_and(|v| !v.is_empty());
        if !indexed {
            UNINDEXED.get_or_init(Default::default).lock().unwrap().insert(canon, Instant::now());
        }
        return None;
    }
    Some(filter_hits(root, hits))
}

/// Start `spotlight_hits` on a helper thread. `None` (no thread) when the
/// folder recently probed as unindexed, the query is empty, or too many
/// earlier queries are still running.
#[cfg(target_os = "macos")]
fn spotlight_spawn(root: &Path, query: &str) -> Option<mpsc::Receiver<Option<Vec<String>>>> {
    md_predicate(query)?;
    let canon = root.canonicalize().ok()?;
    let unindexed = UNINDEXED.get_or_init(Default::default);
    if unindexed.lock().unwrap().get(&canon).is_some_and(|t| t.elapsed() < PROBE_TTL) {
        return None;
    }
    let (root, query) = (root.to_path_buf(), query.to_string());
    spotlight_macos::spawn(move || spotlight_hits(&root, &query))
}

#[cfg(not(target_os = "macos"))]
pub fn spotlight_hits(_root: &Path, _query: &str) -> Option<Vec<String>> {
    None
}

#[cfg(not(target_os = "macos"))]
fn spotlight_spawn(_root: &Path, _query: &str) -> Option<mpsc::Receiver<Option<Vec<String>>>> {
    None
}

/// Rank candidates. Markdown files come first, then by score, then shorter paths.
/// Empty query: markdown files first, shallow paths first, alphabetical.
pub fn rank(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let q: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
    let mut scored: Vec<(bool, i64, &String)> = files
        .iter()
        .filter_map(|f| {
            let s = if q.is_empty() { Some(0) } else { score(&q, f) };
            s.map(|s| (is_markdown(f), s, f))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.cmp(&a.1))
            .then(a.2.matches('/').count().cmp(&b.2.matches('/').count()))
            .then(a.2.len().cmp(&b.2.len()))
            .then(a.2.cmp(b.2))
    });
    scored.into_iter().take(limit).map(|(_, _, f)| f.clone()).collect()
}

fn is_boundary(prev: Option<char>, cur: char) -> bool {
    match prev {
        None => true,
        Some(p) => matches!(p, '/' | '\\' | '_' | '-' | '.' | ' ') || (p.is_lowercase() && cur.is_uppercase()),
    }
}

/// Fuzzy subsequence score of lowercase query `q` against `candidate`, or None.
/// Tries a match inside the file name first (big bonus), then the whole path.
pub fn score(q: &[char], candidate: &str) -> Option<i64> {
    let name_start = candidate.rfind('/').map(|i| i + 1).unwrap_or(0);
    let name = &candidate[name_start..];
    if let Some(s) = score_in(q, name) {
        let exact_stem = name
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(name)
            .to_lowercase()
            .chars()
            .eq(q.iter().copied());
        return Some(s + 40 + if exact_stem { 100 } else { 0 });
    }
    score_in(q, candidate)
}

fn score_in(q: &[char], text: &str) -> Option<i64> {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    // forward pass: earliest end position
    let mut qi = 0;
    let mut end = None;
    for (i, c) in lower.iter().enumerate() {
        if qi < q.len() && *c == q[qi] {
            qi += 1;
            if qi == q.len() {
                end = Some(i);
                break;
            }
        }
    }
    let end = end?;
    // backward pass from `end`: latest start → tighter match
    let mut positions = vec![0usize; q.len()];
    let mut qj = q.len();
    let mut i = end as isize;
    while qj > 0 && i >= 0 {
        if lower[i as usize] == q[qj - 1] {
            qj -= 1;
            positions[qj] = i as usize;
        }
        i -= 1;
    }
    let mut s: i64 = 0;
    for (k, &p) in positions.iter().enumerate() {
        s += 10;
        let prev = if p == 0 { None } else { Some(chars[p - 1]) };
        if is_boundary(prev, chars[p]) {
            s += 8;
        }
        if k > 0 {
            let gap = p - positions[k - 1] - 1;
            if gap == 0 {
                s += 12;
            } else {
                s -= (gap as i64).min(10);
            }
        }
    }
    s -= (positions[0] as i64).min(15) / 3;
    s -= (chars.len() as i64) / 20;
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn subsequence_required() {
        assert!(score(&q("rdm"), "README.md").is_some());
        assert!(score(&q("xyz"), "README.md").is_none());
    }

    #[test]
    fn prefers_contiguous_and_filename() {
        let a = score(&q("note"), "docs/notes.md").unwrap();
        let b = score(&q("note"), "n/o/t/e.md").unwrap();
        assert!(a > b);
        let in_name = score(&q("api"), "guide/api.md").unwrap();
        let in_dir = score(&q("api"), "api/guide.md").unwrap();
        assert!(in_name > in_dir);
    }

    #[test]
    fn markdown_first_and_limit() {
        let files: Vec<String> = ["src/todo.rs", "todo.md", "deep/a/todo.txt", "img/todo.png"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let r = rank(&files, "todo", 10);
        assert_eq!(r[0], "todo.md");
        assert_eq!(r[1], "deep/a/todo.txt");
        assert!(r.len() == 4);
        assert_eq!(rank(&files, "todo", 2).len(), 2);
        let r = rank(&files, "", 10);
        assert_eq!(r[0], "todo.md");
    }

    #[test]
    fn camel_and_boundaries() {
        let a = score(&q("gs"), "GettingStarted.md").unwrap();
        let b = score(&q("gs"), "progress.md").unwrap();
        assert!(a > b);
    }

    #[test]
    fn walk_respects_gitignore_and_updates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("build/out.md"), "").unwrap();
        std::fs::write(root.join("node_modules/x/r.md"), "").unwrap();
        std::fs::write(root.join("docs/a.md"), "").unwrap();
        let qo = QuickOpen::default();
        let r = qo.search(root, "", 10, true);
        assert_eq!(r, vec![root.join("docs/a.md").to_string_lossy().into_owned()]);
        std::fs::write(root.join("b.md"), "").unwrap();
        qo.on_created(&root.join("b.md"), false);
        assert_eq!(qo.search(root, "b", 10, true).len(), 1);
        qo.on_removed(&root.join("docs"));
        assert_eq!(qo.search(root, "a.md", 10, true).len(), 0);
    }
}

#[cfg(test)]
#[path = "quick_open_spotlight_tests.rs"]
mod spotlight_tests;

#[cfg(test)]
#[path = "quick_open_bench.rs"]
mod bench;
