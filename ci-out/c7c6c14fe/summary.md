| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 3s |  |
| vitest | ✅ pass | 4s | 595/595 tests |
| e2e | ❌ fail | 128s | chromium 205/206, webkit 201/206, **2 failed** |
| cargo_test | ✅ pass | 16s | 160 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 24s | clean |
| bundle | ✅ pass | 212s | Margin_0.1.0_amd64.AppImage (81.4 MB), Margin_0.1.0_amd64.deb (6.5 MB) |
| smoke | ✅ pass | 10s | window ok, screenshot stddev 0.377855 |
| native_qa | ✅ pass | 33s | 11/13 pass |

Wall time 295s (js and rust lanes run in parallel). Cache: e2e port: 43515; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<details><summary>e2e log tail</summary>

```
      182 |           if (!png) return null;
        at /ci/work/tests/e2e/parity-ctx.spec.ts:179:14
        at /ci/work/tests/e2e/parity-ctx.spec.ts:177:5
    Error Context: test-results/parity-ctx-parity-context--49405-opy-emoji-copy-inline-math--webkit-retry1/error-context.md
    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/parity-ctx-parity-context--49405-opy-emoji-copy-inline-math--webkit-retry1/trace.zip
    Usage:
        npx playwright show-trace test-results/parity-ctx-parity-context--49405-opy-emoji-copy-inline-math--webkit-retry1/trace.zip
    ────────────────────────────────────────────────────────────────────────────────────────────────
  2) [webkit] › tests/e2e/parity-images.spec.ts:157:1 › images.delete: Image context: Delete Image / Delete Image File (undoable) 
    Test timeout of 30000ms exceeded.
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
  2 failed
    [webkit] › tests/e2e/parity-ctx.spec.ts:167:3 › parity: context menus (#97) › ctx.emoji: Emoji/inline-math context entries (copy emoji, copy inline math) 
    [webkit] › tests/e2e/parity-images.spec.ts:157:1 › images.delete: Image context: Delete Image / Delete Image File (undoable) 
  4 skipped
  406 passed (2.1m)
```
</details>
