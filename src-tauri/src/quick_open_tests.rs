//! Quick Open edge cases: Unicode, ignore rules on incremental updates, big trees,
//! scorer properties.

use crate::quick_open::*;
use std::fs;
use std::path::Path;

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

fn names(r: &[String], root: &Path) -> Vec<String> {
    r.iter().map(|p| Path::new(p).strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")).collect()
}

#[test]
fn nfd_file_names_match_nfc_queries_and_vice_versa() {
    let nfd = "Cafe\u{301} notes.md"; // e + combining acute (how HFS+/zip often store names)
    let nfc = "Caf\u{e9} notes.md";
    let files = vec![nfd.to_string(), "other.md".to_string()];
    assert_eq!(rank(&files, "café", 10), vec![nfd.to_string()], "NFC query vs NFD name");
    let files = vec![nfc.to_string()];
    assert_eq!(rank(&files, "cafe\u{301}", 10), vec![nfc.to_string()], "NFD query vs NFC name");
    // exact-stem bonus applies across normalization forms too
    let a = score(&chars("café notes"), nfd).unwrap();
    let b = score(&chars("café notes"), "café notes and more.md").unwrap();
    assert!(a > b);
}

#[test]
fn case_folding_that_changes_length() {
    // 'İ'.to_lowercase() is two chars ("i̇"): query and text must fold the same way
    let files = vec!["İstanbul.md".to_string(), "ıx.md".to_string()];
    assert_eq!(rank(&files, "İstanbul", 10), vec!["İstanbul.md".to_string()]);
    assert_eq!(rank(&files, "istanbul", 10), vec!["İstanbul.md".to_string()]);
    assert!(score(&chars("ß"), "Straße.md").is_some());
    assert!(score(&chars("ΣΟΦΙΑ").iter().flat_map(|c| c.to_lowercase()).collect::<Vec<_>>(), "σοφία.md").is_none());
}

#[test]
fn cjk_emoji_and_whitespace_queries() {
    let files: Vec<String> = ["笔记/会议记录.md", "notes/😀 smile.md", "a b c.md"].iter().map(|s| s.to_string()).collect();
    assert_eq!(rank(&files, "会议", 5)[0], "笔记/会议记录.md");
    assert_eq!(rank(&files, "😀", 5)[0], "notes/😀 smile.md");
    assert_eq!(rank(&files, "  a b  c ", 5)[0], "a b c.md");
    assert_eq!(rank(&files, "   ", 5).len(), 3, "whitespace-only query = empty query");
}

#[test]
fn scorer_never_panics_on_odd_input() {
    let cands = ["", "/", "//", "a/", ".md", "..", "a//b.md", "\u{301}", "x\u{0}y.md", "🙂🙂🙂"];
    let queries = ["", "/", ".", "\u{301}", "🙂", "a/b", "zzzz", "\u{0}"];
    for c in cands {
        for q in queries {
            let _ = score(&chars(q), c);
        }
    }
    let files: Vec<String> = cands.iter().map(|s| s.to_string()).collect();
    for q in queries {
        let _ = rank(&files, q, 3);
    }
}

#[test]
fn ranking_is_deterministic_and_limit_respected() {
    let files: Vec<String> = (0..500).map(|i| format!("d{}/note{i}.md", i % 7)).collect();
    let a = rank(&files, "note1", 20);
    let mut rev = files.clone();
    rev.reverse();
    let b = rank(&rev, "note1", 20);
    assert_eq!(a, b, "order must not depend on input order");
    assert_eq!(a.len(), 20);
    assert_eq!(a[0], "d1/note1.md");
}

#[test]
fn incremental_updates_respect_ignore_rules() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::write(root.join("docs/.gitignore"), "private.md\n").unwrap();
    fs::write(root.join("docs/a.md"), "").unwrap();
    let qo = QuickOpen::default();
    assert_eq!(qo.search(root, "", 50, true).len(), 1);
    for rel in ["build/out.md", "x.log", "docs/private.md", "node_modules/p/r.md", "target/t.md", "docs/ok.md"] {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "").unwrap();
        qo.on_created(&p, false);
    }
    let got = names(&qo.search(root, "", 50, true), root);
    let mut got = got;
    got.sort();
    assert_eq!(got, vec!["docs/a.md", "docs/ok.md"], "watcher-created files must obey .gitignore/skip dirs");
}

#[test]
fn renamed_directory_contents_follow() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("old")).unwrap();
    fs::write(root.join("old/n.md"), "").unwrap();
    let qo = QuickOpen::default();
    assert_eq!(qo.search(root, "n", 10, true).len(), 1);
    fs::rename(root.join("old"), root.join("new")).unwrap();
    qo.on_removed(&root.join("old"));
    qo.on_created(&root.join("new"), true);
    assert_eq!(names(&qo.search(root, "n.md", 10, true), root), vec!["new/n.md"]);
}

#[test]
fn unicode_file_names_on_disk_are_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for n in ["日本語.md", "Ünïcödé.md", "emoji 🎉.md", "with space.md"] {
        fs::write(root.join(n), "").unwrap();
    }
    let qo = QuickOpen::default();
    assert_eq!(qo.search(root, "", 50, false).len(), 4);
    assert_eq!(names(&qo.search(root, "日本", 5, false), root), vec!["日本語.md"]);
    assert_eq!(names(&qo.search(root, "unicode", 5, false), root), Vec::<String>::new(), "no diacritic folding (documented)");
    assert_eq!(names(&qo.search(root, "ünï", 5, false), root), vec!["Ünïcödé.md"]);
}

#[test]
fn huge_tree_is_capped_and_markdown_survives_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // > MAX_INDEX non-markdown files, plus a few notes deep inside
    let per = 1000;
    for d in 0..(MAX_INDEX / per + 2) {
        let sub = root.join(format!("assets{d:03}"));
        fs::create_dir_all(&sub).unwrap();
        for i in 0..per {
            fs::File::create(sub.join(format!("{i}.png"))).unwrap();
        }
    }
    fs::create_dir_all(root.join("zz/notes")).unwrap();
    fs::write(root.join("zz/notes/important.md"), "").unwrap();
    let t = std::time::Instant::now();
    let qo = QuickOpen::default();
    let r = qo.search(root, "important", 5, false);
    let took = t.elapsed();
    assert_eq!(names(&r, root), vec!["zz/notes/important.md"], "markdown must not be dropped by the cap");
    assert!(took < std::time::Duration::from_secs(10), "walk took {took:?}");
    eprintln!("walk of {} files: {took:?}", MAX_INDEX + 2 * per);
}
