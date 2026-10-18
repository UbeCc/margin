| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 3s | 442/442 tests |
| e2e | ✅ pass | 39s | chromium 113/114, webkit 111/114 |
| cargo_test | ✅ pass | 16s | 109 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 28s | clean |
| bundle | ✅ pass | 190s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377864 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 277s (js and rust lanes run in parallel). Cache: e2e port: 37327; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.
