### ❌ `dev_0911-ci` — 2db44c742

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 993s end to end.

CI did not produce a summary (exit 1). Last lines:
```
        54 × waiting for element to be visible, enabled and stable
           - element is visible, enabled and stable
           - scrolling into view if needed
           - done scrolling
           - performing click action
           - <div class="md-content">…</div> intercepts pointer events
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
    Error Context: test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit-retry1/error-context.md
    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit-retry1/trace.zip
    Usage:
        npx playwright show-trace test-results/parity-images-images-delet-9db1a-Delete-Image-File-undoable--webkit-retry1/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  1 failed
    [webkit] › tests/e2e/parity-images.spec.ts:157:1 › images.delete: Image context: Delete Image / Delete Image File (undoable) 
  4 skipped
  279 passed (1.7m)
```
</details>
```

<sub>`scripts/ci-remote.sh 135` · logs in `ci-out/2db44c742/` on the runner's checkout</sub>
