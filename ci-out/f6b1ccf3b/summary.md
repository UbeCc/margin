| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 1s |  |
| vitest | ✅ pass | 1s | 88/88 tests, 26 files |
| e2e | ❌ fail | 17s | chromium 16/16, webkit 14/16, **2 failed** |
| cargo_test | ✅ pass | 8s | 30 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 2s | clean |
| bundle | ✅ pass | 233s | Margin_0.1.0_amd64.AppImage (78.2 MB), Margin_0.1.0_amd64.deb (3.2 MB) |
| smoke | ✅ pass | 10s | window ok, screenshot stddev 0.376439 |

Wall time 253s (js and rust lanes run in parallel). Cache: node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: cold.

<details><summary>e2e log tail</summary>

```
        npx playwright show-trace test-results/blocks-widgets-html-front--a4b31-k-is-sanitized-and-editable-webkit/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
    Retry #1 ───────────────────────────────────────────────────────────────────────────────────────
    Error: expect(locator).toHaveText(expected) failed
    Locator: locator('[data-host="html_block"]').locator('.mb-preview p')
    Expected: "new"
    Error: strict mode violation: locator('[data-host="html_block"]').locator('.mb-preview p') resolved to 2 elements:
        1) <p>new</p> aka getByText('new', { exact: true })
        2) <p></p> aka getByRole('paragraph').filter({ hasText: /^$/ })
    Call log:
      - Expect "toHaveText" locator('[data-host="html_block"]').locator('.mb-preview p') with timeout 5000ms
      - waiting for locator('[data-host="html_block"]').locator('.mb-preview p')
      188 |     await page.keyboard.press(`${mod}+a`);
      189 |     await page.keyboard.type('<p>new</p>');
    > 190 |     await expect(h.locator('.mb-preview p')).toHaveText('new');
          |                                              ^
      191 |     expect(await raw(page, 'html_block')).toBe('<p>new</p>\n');
      192 |   });
      193 |
        at /ci/work/tests/e2e/blocks-widgets.spec.ts:190:46
    Error Context: test-results/blocks-widgets-html-front--a4b31-k-is-sanitized-and-editable-webkit-retry1/error-context.md
    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/blocks-widgets-html-front--a4b31-k-is-sanitized-and-editable-webkit-retry1/trace.zip
    Usage:
        npx playwright show-trace test-results/blocks-widgets-html-front--a4b31-k-is-sanitized-and-editable-webkit-retry1/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  2 failed
    [webkit] › tests/e2e/blocks-widgets.spec.ts:31:3 › code fence › language box edits info string, copy button works 
    [webkit] › tests/e2e/blocks-widgets.spec.ts:182:3 › html, front matter, toc › html block is sanitized and editable 
  30 passed (16.2s)
```
</details>
