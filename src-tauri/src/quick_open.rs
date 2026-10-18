//! Quick Open: a cached file index per root (built with the `ignore` walker, so
//! `.gitignore`/hidden files are respected) plus a small fuzzy scorer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MAX_INDEX: usize = 50_000;
/// Stop walking after this many files even when looking for markdown past the cap.
pub const MAX_VISIT: usize = 400_000;
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
    let mut visited = 0usize;
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
        visited += 1;
        if visited > MAX_VISIT {
            break;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            // Past the cap keep collecting notes: a big asset tree must not hide them.
            if out.len() < MAX_INDEX || (is_markdown(&rel) && out.len() < 2 * MAX_INDEX) {
                out.push(rel);
            }
        }
    }
    out
}

/// Would `walk` have skipped `rel` (a file under `root`)? Hidden components, the
/// skip dirs, and `.gitignore`/`.ignore` files from `root` down to the file's dir,
/// deepest first (so a nested `!pattern` can re-include).
pub fn is_excluded(root: &Path, rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|c| c.starts_with('.')) || parts[..parts.len().saturating_sub(1)].iter().any(|c| SKIP_DIRS.contains(c)) {
        return true;
    }
    let full = root.join(rel);
    for depth in (0..parts.len()).rev() {
        let dir = parts[..depth].iter().fold(root.to_path_buf(), |p, c| p.join(c));
        for name in [".ignore", ".gitignore"] {
            let file = dir.join(name);
            if !file.is_file() {
                continue;
            }
            let (gi, _) = ignore::gitignore::Gitignore::new(&file);
            match gi.matched_path_or_any_parents(&full, false) {
                ignore::Match::Ignore(_) => return true,
                ignore::Match::Whitelist(_) => return false,
                ignore::Match::None => {}
            }
        }
    }
    false
}

#[derive(Default)]
pub struct QuickOpen {
    indexes: Mutex<HashMap<PathBuf, Index>>,
}

impl QuickOpen {
    pub fn search(&self, root: &Path, query: &str, limit: usize, watched: bool) -> Vec<String> {
        let mut map = self.indexes.lock().unwrap();
        let stale = match map.get(root) {
            None => true,
            Some(ix) => ix.dirty || (!watched && ix.built.elapsed() > UNWATCHED_TTL),
        };
        if stale {
            drop(map);
            let files = walk(root); // walk without holding the lock
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
        self.update_with_root(path, |root, files, rel| {
            if is_dir {
                return false; // unknown contents: rebuild lazily
            }
            if !files.iter().any(|f| f == rel) && !is_excluded(root, rel) {
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

    pub fn forget(&self, root: &Path) {
        self.indexes.lock().unwrap().remove(root);
    }

    fn update(&self, path: &Path, f: impl Fn(&mut Vec<String>, &str) -> bool) {
        self.update_with_root(path, |_, files, rel| f(files, rel));
    }

    fn update_with_root(&self, path: &Path, f: impl Fn(&Path, &mut Vec<String>, &str) -> bool) {
        let mut map = self.indexes.lock().unwrap();
        for (root, ix) in map.iter_mut() {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if rel.is_empty() || !f(root, &mut ix.files, &rel) {
                    ix.dirty = true;
                }
            }
        }
    }
}

/// Rank candidates. Markdown files come first, then by score, then shorter paths.
/// Empty query: markdown files first, shallow paths first, alphabetical.
pub fn rank(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let q: Vec<char> = fold_query(query);
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

/// Case-fold one char the same way for queries and candidates. Chars whose lowercase
/// form is longer (`İ` → `i̇`) fold to its first char so positions stay aligned.
pub fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// NFC-normalize (macOS/zip names are often NFD), drop whitespace, case-fold.
pub fn fold_query(query: &str) -> Vec<char> {
    use unicode_normalization::UnicodeNormalization;
    query.nfc().filter(|c| !c.is_whitespace()).map(fold).collect()
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
    use unicode_normalization::{UnicodeNormalization, is_nfc_quick, IsNormalized};
    let q: Vec<char> = if q.iter().copied().all(|c| (c as u32) < 0x300) {
        q.iter().copied().map(fold).collect()
    } else {
        q.iter().collect::<String>().nfc().map(fold).collect()
    };
    let q = &q[..];
    let normalized;
    let candidate = if is_nfc_quick(candidate.chars()) == IsNormalized::Yes {
        candidate
    } else {
        normalized = candidate.nfc().collect::<String>();
        normalized.as_str()
    };
    let name_start = candidate.rfind('/').map(|i| i + 1).unwrap_or(0);
    let name = &candidate[name_start..];
    if let Some(s) = score_in(q, name) {
        let exact_stem = name
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(name)
            .chars()
            .map(fold)
            .eq(q.iter().copied());
        return Some(s + 40 + if exact_stem { 100 } else { 0 });
    }
    score_in(q, candidate)
}

fn score_in(q: &[char], text: &str) -> Option<i64> {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| fold(*c)).collect();
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
