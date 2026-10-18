//! Walker vs Spotlight Quick Open benchmark (macOS, `#[ignore]`).
//!
//! Spotlight only answers for indexed folders, so point it at an indexed
//! location (e.g. under ~/Documents) and let the test wait for mds:
//!
//! ```sh
//! MARGIN_BENCH_DIR=~/Documents/margin-qo-bench MARGIN_BENCH_FILES=20000 \
//!   cargo test --release --lib quick_open_bench -- --ignored --nocapture
//! ```
//! The folder is generated once (re-used if present) and not deleted.

use super::*;
use std::fs;

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

fn ms(d: Duration) -> String {
    format!("{:.1} ms", d.as_secs_f64() * 1e3)
}

fn generate(root: &Path, n: usize) {
    if root.join(".generated").exists() {
        return;
    }
    let words = ["alpha", "notes", "draft", "todo", "meeting", "design", "api", "guide", "journal", "readme"];
    for i in 0..n {
        let dir = root.join(format!("d{:02}/s{:02}", i % 50, (i / 50) % 20));
        fs::create_dir_all(&dir).unwrap();
        let ext = ["png", "md", "md", "md", "md"][i % 5];
        let name = format!("{}-{}-{i}.{ext}", words[i % 10], words[(i / 10) % 10]);
        fs::write(dir.join(name), "# x\n").unwrap();
    }
    fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    fs::write(root.join("node_modules/pkg/readme.md"), "").unwrap();
    fs::write(root.join(".generated"), "").unwrap();
}

#[test]
#[ignore]
fn quick_open_bench() {
    let root = PathBuf::from(std::env::var("MARGIN_BENCH_DIR").expect("set MARGIN_BENCH_DIR"));
    let n: usize = std::env::var("MARGIN_BENCH_FILES").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000);
    let existing = std::env::var("MARGIN_BENCH_EXISTING").is_ok(); // bench an existing tree as-is
    let t = Instant::now();
    if !existing {
        generate(&root, n);
    }
    println!("generate/reuse {n} files: {}", ms(t.elapsed()));

    #[cfg(target_os = "macos")]
    if !existing {
        // wait (≤ 10 min) until Spotlight has indexed most generated markdown files
        let want = n * 4 / 5 * 9 / 10;
        let t = Instant::now();
        loop {
            let got = spotlight_macos::query_blocking(&root.canonicalize().unwrap(), r#"kMDItemFSName == "*.md"c"#, n)
                .map(|v| v.len())
                .unwrap_or(0);
            if got >= want || t.elapsed() > Duration::from_secs(600) {
                println!("spotlight indexed {got}/{want} expected md hits after {}", ms(t.elapsed()));
                break;
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    }

    let queries = ["todo", "mtgnotes", "api-guide-1234", "zzzz"];
    #[cfg(target_os = "macos")]
    for q in queries {
        let canon = root.canonicalize().unwrap();
        let t = Instant::now();
        let n = spotlight_macos::query_blocking(&canon, &md_predicate(q).unwrap(), SPOTLIGHT_MAX).map(|v| v.len());
        println!("q={q:<16} raw MDQuery (no timeout) {:>10} ({n:?} paths)", ms(t.elapsed()));
    }
    for q in queries {
        let walk_t: Vec<Duration> = (0..5)
            .map(|_| {
                let t = Instant::now();
                let files = walk(&root);
                let _ = rank(&files, q, 50);
                t.elapsed()
            })
            .collect();
        let spot_t: Vec<(Duration, usize)> = (0..5)
            .map(|_| {
                let t = Instant::now();
                let hits = spotlight_hits(&root, q).unwrap_or_default();
                let len = hits.len();
                let _ = rank(&merge(&[], hits), q, 50);
                (t.elapsed(), len)
            })
            .collect();
        let hits = spot_t[0].1;
        let spot = median(spot_t.into_iter().map(|x| x.0).collect());
        println!("q={q:<16} walker+rank {:>10}   spotlight+filter+rank {:>10} ({hits} hits)", ms(median(walk_t)), ms(spot));
    }

    // End-to-end cold search through QuickOpen (fresh instance each time).
    for (label, on) in [("cold search, walker only", false), ("cold search, forced race", true)] {
        let d: Vec<Duration> = (0..5)
            .map(|_| {
                std::thread::sleep(Duration::from_millis(600)); // let earlier Spotlight queries drain
                let qo = QuickOpen::with_spotlight(on);
                let t = Instant::now();
                let r = qo.search(&root, "todo", 50, true);
                assert!(!r.is_empty());
                let e = t.elapsed();
                while !qo.building.lock().unwrap().is_empty() {
                    std::thread::sleep(Duration::from_millis(10)); // let the background walk finish
                }
                e
            })
            .collect();
        println!("{label:<28} {:>10}  all: {:?}", ms(median(d.clone())), d.iter().map(|x| x.as_millis()).collect::<Vec<_>>());
    }
}
