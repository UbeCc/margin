| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 3s |  |
| typecheck | ✅ pass | 1s |  |
| vitest | ✅ pass | 1s | 88/88 tests, 26 files |
| e2e | ❌ fail | 22s | chromium 15/16, webkit 14/16, **3 failed** |
| cargo_test | ✅ pass | 67s | 29 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ⚠️ warn | 33s | 11 diagnostics |
| bundle | ⏭️ skip | 0s |  |
| smoke | ⏭️ skip | 0s |  |

Wall time 103s (js and rust lanes run in parallel). Cache: node_modules: miss (lock 975215959a357a01); cargo debug target: cold.

<details><summary>e2e log tail</summary>

```
    test-results/blocks-widgets-code-fence--4dd52-fo-string-copy-button-works-webkit/trace.zip
    Usage:
        npx playwright show-trace test-results/blocks-widgets-code-fence--4dd52-fo-string-copy-button-works-webkit/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  3) [webkit] › tests/e2e/blocks-widgets.spec.ts:182:3 › html, front matter, toc › html block is sanitized and editable 
    Error: expect(received).toBe(expected) // Object.is equality
    - Expected  - 1
    + Received  + 1
    - <p>new</p>
    + <p>new</p></p>
      ↵
      189 |     await page.keyboard.type('<p>new</p>');
      190 |     await expect(h.locator('.mb-preview p')).toHaveText('new');
    > 191 |     expect(await raw(page, 'html_block')).toBe('<p>new</p>\n');
          |                                           ^
      192 |   });
      193 |
      194 |   test('front matter collapsed box and yaml editing', async ({ page }) => {
        at /ci/work/tests/e2e/blocks-widgets.spec.ts:191:43
    Error Context: test-results/blocks-widgets-html-front--a4b31-k-is-sanitized-and-editable-webkit/error-context.md
    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/blocks-widgets-html-front--a4b31-k-is-sanitized-and-editable-webkit/trace.zip
    Usage:
        npx playwright show-trace test-results/blocks-widgets-html-front--a4b31-k-is-sanitized-and-editable-webkit/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  3 failed
    [chromium] › tests/e2e/blocks-widgets.spec.ts:182:3 › html, front matter, toc › html block is sanitized and editable 
    [webkit] › tests/e2e/blocks-widgets.spec.ts:31:3 › code fence › language box edits info string, copy button works 
    [webkit] › tests/e2e/blocks-widgets.spec.ts:182:3 › html, front matter, toc › html block is sanitized and editable 
  29 passed (21.1s)
```
</details>
