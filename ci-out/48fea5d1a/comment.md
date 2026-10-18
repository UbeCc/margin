### ❌ `dev_0911-ci` — 48fea5d1a

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 228s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 476/476 tests |
| e2e | ✅ pass | 38s | chromium 115/116, webkit 113/116 |
| cargo_test | ❌ fail | 14s | 125 passed, 1 failed |
| clippy | ⛔ blocked | 0s | clean |
| bundle | ⛔ blocked | 0s |  |
| smoke | ⛔ blocked | 0s |  |
| native_qa | ⛔ blocked | 0s | 0/0 pass |

Wall time 44s (js and rust lanes run in parallel). Cache: e2e port: 41515; node_modules: hit (lock 975215959a357a01); cargo debug target: warm.

<details><summary>cargo_test log tail</summary>

```
test upload::tests::unix::hostile_file_names_are_plain_argv ... ok
test pandoc::tests::fake::detect_accepts_v2_plus_from_configured_dir_and_path ... ok
test watch::tests::live_watch_reports_external_changes ... ok
test watch_live_tests::delete_and_recreate_is_a_modify ... ok
test watch_live_tests::jetbrains_safe_write_is_a_modify ... ok
test watch_live_tests::moved_in_and_moved_out ... ok
test watch_live_tests::rename_and_delete_in_folder ... ok
test watch_live_tests::own_saves_in_watched_folder ... ok
test watch_live_tests::burst_of_creates_reports_each_file_once ... ok
test watch_live_tests::symlinked_file_reports_the_link_path ... ok
test quick_open_tests::huge_tree_is_capped_and_markdown_survives_the_cap ... ok
test watch_live_tests::create_then_delete_within_one_batch_is_silent ... ok
test watch_live_tests::hidden_and_vcs_noise_is_ignored ... ok
test watch_live_tests::directory_rename_and_its_children ... ok
test watch_live_tests::vim_save_in_watched_folder_is_a_modify ... ok
test watch_live_tests::file_watch_reports_delete_and_rename_away ... ok
test watch_live_tests::file_watch_survives_repeated_atomic_saves ... ok
test watch_live_tests::file_watch_own_save_is_silent_then_external_change_seen ... ok
test watch_live_tests::vim_save_of_watched_file_is_a_modify ... ok
test pandoc::tests::fake::hang_times_out_and_kills ... ok
test upload::tests::unix::timeout_kills_child ... ok
failures:
---- pandoc::tests::fake::garbage_version_output_is_rejected stdout ----
thread 'pandoc::tests::fake::garbage_version_output_is_rejected' (702652) panicked at src/pandoc_tests.rs:190:9:
Failed to start /tmp/.tmpCnhYen/pandoc: Text file busy (os error 26)
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
failures:
    pandoc::tests::fake::garbage_version_output_is_rejected
test result: FAILED. 125 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 7.02s
error: test failed, to rerun pass `--lib`
```
</details>

<sub>`scripts/ci-remote.sh 110` · logs in `ci-out/48fea5d1a/` on the runner's checkout</sub>
