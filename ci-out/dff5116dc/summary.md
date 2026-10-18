| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 467/467 tests |
| e2e | ❌ fail | 39s | chromium 118/120, webkit 117/120, **1 failed** |
| cargo_test | ❌ fail | 19s | 120 passed, 1 failed |
| clippy | ⛔ blocked | 0s | clean |
| bundle | ⛔ blocked | 0s |  |
| smoke | ⛔ blocked | 0s |  |
| native_qa | ⛔ blocked | 0s | 0/0 pass |

Wall time 45s (js and rust lanes run in parallel). Cache: e2e port: 42489; node_modules: hit (lock 975215959a357a01); cargo debug target: warm.

<details><summary>e2e log tail</summary>

```
    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────
    Error: expect(received).toBe(expected) // Object.is equality
    - Expected  - 1
    + Received  + 1
      Some **bold** text
      end
    - Some bold text
    + Some **bold** text
      end
      ↵
    Call Log:
    - Timeout 5000ms exceeded while waiting on the predicate
      148 |       await caret(page, 1, 3);
      149 |       await page.keyboard.press('Control+Shift+v');
    > 150 |       await expect.poll(() => md(page)).toBe(PLAIN);
          |                                         ^
      151 |       await page.keyboard.press(`${mod}+z`);
      152 |     }
      153 |     // a normal ⌘V still pastes rich markdown
        at /ci/work/tests/e2e/parity-clipboard.spec.ts:150:41
    Error Context: test-results/parity-clipboard-parity-cl-fa335--Edit-›-Paste-as-Plain-Text-chromium-retry1/error-context.md
    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/parity-clipboard-parity-cl-fa335--Edit-›-Paste-as-Plain-Text-chromium-retry1/trace.zip
    Usage:
        npx playwright show-trace test-results/parity-clipboard-parity-cl-fa335--Edit-›-Paste-as-Plain-Text-chromium-retry1/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  1 failed
    [chromium] › tests/e2e/parity-clipboard.spec.ts:125:3 › parity: clipboard & selection (#96) › menu.edit.paste-plain: Edit › Paste as Plain Text 
  4 skipped
  235 passed (39.0s)
```
</details>

<details><summary>cargo_test log tail</summary>

```
test upload::tests::unix::hostile_file_names_are_plain_argv ... ok
test upload::tests::unix::url_count_mismatch_is_an_error ... ok
test pandoc::tests::fake::detect_accepts_v2_plus_from_configured_dir_and_path ... ok
test watch::tests::live_watch_reports_external_changes ... ok
test watch_live_tests::delete_and_recreate_is_a_modify ... ok
test watch_live_tests::jetbrains_safe_write_is_a_modify ... ok
test watch_live_tests::moved_in_and_moved_out ... ok
test watch_live_tests::rename_and_delete_in_folder ... ok
test watch_live_tests::symlinked_file_reports_the_link_path ... ok
test watch_live_tests::own_saves_in_watched_folder ... ok
test watch_live_tests::burst_of_creates_reports_each_file_once ... ok
test watch_live_tests::vim_save_in_watched_folder_is_a_modify ... ok
test quick_open_tests::huge_tree_is_capped_and_markdown_survives_the_cap ... ok
test watch_live_tests::create_then_delete_within_one_batch_is_silent ... ok
test watch_live_tests::hidden_and_vcs_noise_is_ignored ... ok
test watch_live_tests::directory_rename_and_its_children ... ok
test watch_live_tests::file_watch_reports_delete_and_rename_away ... ok
test watch_live_tests::file_watch_survives_repeated_atomic_saves ... ok
test watch_live_tests::vim_save_of_watched_file_is_a_modify ... ok
test watch_live_tests::file_watch_own_save_is_silent_then_external_change_seen ... ok
test upload::tests::unix::timeout_kills_child ... ok
failures:
---- pandoc::tests::fake::hang_times_out_and_kills stdout ----
thread 'pandoc::tests::fake::hang_times_out_and_kills' (722659) panicked at src/pandoc_tests.rs:160:9:
Failed to start /tmp/.tmp6rGHrY/pandoc: Text file busy (os error 26)
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
failures:
    pandoc::tests::fake::hang_times_out_and_kills
test result: FAILED. 120 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 7.02s
error: test failed, to rerun pass `--lib`
```
</details>
