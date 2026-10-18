| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 459/459 tests |
| e2e | ✅ pass | 39s | chromium 115/116, webkit 113/116 |
| cargo_test | ✅ pass | 21s | 130 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ⚠️ warn | 25s | 12 diagnostics |
| bundle | ✅ pass | 188s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377866 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 277s (js and rust lanes run in parallel). Cache: e2e port: 34597; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.
