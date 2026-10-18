### ❌ `dev_0911-ci` — e9dc168d8

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 1086s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 485/485 tests |
| e2e | ❌ fail | 55s | chromium 136/137, webkit 133/137, **1 failed** |
| cargo_test | ✅ pass | 20s | 133 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 26s | clean |
| bundle | ✅ pass | 193s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377856 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 282s (js and rust lanes run in parallel). Cache: e2e port: 32769; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<details><summary>e2e log tail</summary>

```
    - Press `⌘/` to flip between rich and source view.·
    ## Writing·
    > Simplicity is the ultimate sophistication.·
    Inline `code`, *emphasis*, ==highlights== and [links](https://example.com) all work.·
    ### 中文排版·
    在 Margin 里，中英文混排也应该舒服：行高宽松，标点不挤，字体回退合理。·
    ## Next steps·
    1. Open a folder from the sidebar.
    2. Try the themes in Preferences.file:///Users/demo/Notes/Ideas/Roadmap.md
    "
    Call Log:
    - Timeout 5000ms exceeded while waiting on the predicate
      127 |   // Into the editor: a relative link at the drop point.
      128 |   await roadmap.dragTo(page.locator('.md-editor .md-block').last());
    > 129 |   await expect.poll(() => editorValue(page)).toContain('[Roadmap](Ideas/Roadmap.md)');
          |                                              ^
      130 |   // Onto a folder: move it there (open document path follows).
      131 |   await tree(page).locator(`.tree-row[data-path="${ROOT}/notes.txt"]`).dragTo(tree(page).locator(`.tree-row[data-path="${ROOT}/Journal"]`));
      132 |   await expect(tree(page).locator(`.tree-row[data-path="${ROOT}/Journal/notes.txt"]`)).toBeVisible();
        at /ci/work/tests/e2e/parity-sidebar.spec.ts:129:46
    Error Context: test-results/parity-sidebar-sidebar-dra-812b8-her-apps-drop-files-to-open-webkit-retry1/error-context.md
    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/parity-sidebar-sidebar-dra-812b8-her-apps-drop-files-to-open-webkit-retry1/trace.zip
    Usage:
        npx playwright show-trace test-results/parity-sidebar-sidebar-dra-812b8-her-apps-drop-files-to-open-webkit-retry1/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  1 failed
    [webkit] › tests/e2e/parity-sidebar.spec.ts:122:1 › sidebar.drag: Drag files from sidebar into the editor / other apps; drop files to open 
  4 skipped
  269 passed (54.2s)
```
</details>

<sub>`scripts/ci-remote.sh 123` · logs in `ci-out/e9dc168d8/` on the runner's checkout</sub>
