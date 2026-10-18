//! Tests for the Spotlight glue in `quick_open.rs` (platform-neutral parts run
//! everywhere; FFI tests are macOS-only).

use super::*;
use std::fs;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[test]
fn escape_quotes_and_wildcards() {
    assert_eq!(md_escape(r#"a"b*c?d\e"#), r#"a\"b\*c\?d\\e"#);
    assert_eq!(md_escape("plain é"), "plain é");
}

#[test]
fn predicate_is_escaped_subsequence() {
    assert_eq!(md_predicate("r d*").unwrap(), r#"kMDItemFSName == "*r*d*\**"cd"#);
    // a quote in the query cannot terminate the string literal
    let p = md_predicate(r#"x" || kMDItemFSName == "*"#).unwrap();
    assert!(p.starts_with(r#"kMDItemFSName == "*x*\"*|*|*k*"#), "{p}");
    assert!(p.ends_with(r#"*\"*\**"cd"#), "{p}");
    // empty query: no predicate (a lone "*" matches nothing in MDQuery)
    assert_eq!(md_predicate("  "), None);
}

#[test]
fn merge_dedupes_and_keeps_cached() {
    let cached = s(&["a.md", "img/x.png"]);
    let merged = merge(&cached, s(&["a.md", "deep/b.md", "deep/b.md"]));
    assert_eq!(merged, s(&["a.md", "img/x.png", "deep/b.md"]));
}

#[test]
fn merged_results_ranked_and_limited() {
    let merged = merge(&s(&["notes/todo.txt", "src/todo.rs"]), s(&["todo.md", "a/b/c/todo.md"]));
    let r = rank(&merged, "todo", 3);
    assert_eq!(r, s(&["todo.md", "notes/todo.txt", "a/b/c/todo.md"]));
}

#[test]
fn filter_applies_walker_rules() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".gitignore"), "build/\n*.tmp.md\n").unwrap();
    fs::create_dir_all(root.join("docs/sub")).unwrap();
    fs::write(root.join("docs/.gitignore"), "sub/\n!keep.tmp.md\n").unwrap();
    let hits: Vec<PathBuf> = [
        "docs/a.md",
        "docs/sub/b.md",
        "docs/keep.tmp.md",
        "x.tmp.md",
        "build/out.md",
        ".hidden/h.md",
        "node_modules/p/r.md",
        "ok.markdown",
        "img/pic.png",
    ]
    .iter()
    .map(|p| root.join(p))
    .chain([PathBuf::from("/elsewhere/z.md"), root.to_path_buf()])
    .collect();
    let mut got = filter_hits(root, hits);
    got.sort();
    assert_eq!(got, s(&["docs/a.md", "docs/keep.tmp.md", "ok.markdown"]));
}

#[cfg(unix)]
#[test]
fn filter_maps_canonical_paths_through_symlinked_root() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir_all(real.join("d")).unwrap();
    fs::write(real.join("d/n.md"), "").unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    // Spotlight reports real paths; the user opened the symlink.
    let canon_hit = real.canonicalize().unwrap().join("d/n.md");
    assert_eq!(filter_hits(&link, vec![canon_hit]), s(&["d/n.md"]));
    let merged = merge(&s(&["d/n.md"]), filter_hits(&link, vec![link.join("d/n.md")]));
    assert_eq!(merged.len(), 1);
}

#[test]
fn spotlight_enabled_search_falls_back_on_unindexed_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("alpha.md"), "").unwrap();
    fs::write(root.join("beta.md"), "").unwrap();
    let qo = QuickOpen::with_spotlight(true);
    let r = qo.search(root, "alp", 10, true);
    assert_eq!(r, vec![root.join("alpha.md").to_string_lossy().into_owned()]);
}

#[test]
fn spotlight_only_for_slow_walking_roots() {
    let root = Path::new("/r");
    let qo = QuickOpen { spotlight_after: Some(SPOTLIGHT_MIN_WALK), ..QuickOpen::with_spotlight(false) };
    assert!(!qo.wants_spotlight(root), "unwalked root: walk first");
    qo.walk_times.lock().unwrap().insert(root.into(), Duration::from_millis(60));
    assert!(!qo.wants_spotlight(root));
    qo.walk_times.lock().unwrap().insert(root.into(), Duration::from_millis(900));
    assert!(qo.wants_spotlight(root));
    assert!(QuickOpen::with_spotlight(true).wants_spotlight(root), "forced");
    assert!(!QuickOpen::with_spotlight(false).wants_spotlight(root));
}

#[cfg(target_os = "macos")]
#[test]
fn malformed_query_yields_no_hits_not_crash() {
    let home = std::env::var("HOME").unwrap();
    let r = spotlight_macos::query_blocking(Path::new(&home), "kMDItemFSName == ((", 1);
    // MDQuery either rejects it or matches nothing; it must never panic.
    assert!(r.as_ref().is_none_or(|v| v.is_empty()), "{r:?}");
}

/// Needs an indexed folder: `MARGIN_SPOTLIGHT_DIR=~/some/indexed/dir cargo test -- --ignored spotlight_live`.
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn spotlight_live_query_on_indexed_folder() {
    let dir = PathBuf::from(std::env::var("MARGIN_SPOTLIGHT_DIR").expect("set MARGIN_SPOTLIGHT_DIR"));
    let hits = spotlight_hits(&dir, "md").expect("folder should be indexed");
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|h| is_markdown(h) && !h.starts_with('/')));
}
