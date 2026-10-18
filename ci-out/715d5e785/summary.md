| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 3s |  |
| vitest | ✅ pass | 4s | 606/606 tests |
| e2e | ❌ fail | 128s | chromium 207/208, webkit 204/208, **1 failed** |
| cargo_test | ✅ pass | 25s | 161 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ⚠️ warn | 26s | 6 diagnostics |
| bundle | ✅ pass | 213s | Margin_0.1.0_amd64.AppImage (81.4 MB), Margin_0.1.0_amd64.deb (6.4 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377855 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 307s (js and rust lanes run in parallel). Cache: e2e port: 39021; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<details><summary>e2e log tail</summary>

```
         - retrying click action
           - waiting 500ms
        - waiting for element to be visible, enabled and stable
      37 | const settings = (page: Page, p: object) => page.evaluate((x) => (window as unknown as Win).__margin.updateSettings(x), p);
      38 | const exists = (page: Page, p: string) => page.evaluate(async (x) => !!(await (window as unknown as Win).__MARGIN_WEB__.stat(x)), p);
    > 39 | const rightClickImage = (page: Page, i = 0) => page.locator('.md-editor .md-image img.md-img, .md-editor .mb-html-block img').nth(i).click({ button: 'right' });
         |                                                                                                                                      ^
      40 | const ctxItem = (page: Page, label: string | RegExp) => page.locator('.context-item', { hasText: label });
      41 |
      42 | test.beforeEach(async ({ page }) => {
        at rightClickImage (/ci/work/tests/e2e/parity-images.spec.ts:39:134)
        at /ci/work/tests/e2e/parity-images.spec.ts:159:9
    Error Context: test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit/error-context.md
    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit/trace.zip
    Usage:
        npx playwright show-trace test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────
    Test timeout of 30000ms exceeded.
    Error Context: test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit-retry1/error-context.md
    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit-retry1/trace.zip
    Usage:
        npx playwright show-trace test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit-retry1/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  1 failed
    [webkit] › tests/e2e/parity-images.spec.ts:157:1 › images.delete: Image context: Delete Image / Delete Image File (undoable) 
  4 skipped
  411 passed (2.1m)
```
</details>
