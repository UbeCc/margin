| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 3s | 462/462 tests |
| e2e | ✅ pass | 46s | chromium 125/126, webkit 123/126 |
| cargo_test | ✅ pass | 20s | 130 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ⚠️ warn | 26s | 12 diagnostics |
| bundle | ✅ pass | 188s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377865 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 277s (js and rust lanes run in parallel). Cache: e2e port: 39185; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.
