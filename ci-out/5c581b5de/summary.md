| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 483/483 tests |
| e2e | ✅ pass | 53s | chromium 149/150, webkit 147/150 |
| cargo_test | ✅ pass | 20s | 132 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 25s | clean |
| bundle | ✅ pass | 202s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377863 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 290s (js and rust lanes run in parallel). Cache: e2e port: 37997; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.
