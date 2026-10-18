| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 479/479 tests |
| e2e | ✅ pass | 46s | chromium 139/140, webkit 137/140 |
| cargo_test | ✅ pass | 20s | 131 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 26s | clean |
| bundle | ✅ pass | 192s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 10s | window ok, screenshot stddev 0.377865 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 280s (js and rust lanes run in parallel). Cache: e2e port: 34751; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.
