| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 3s | 333/333 tests |
| e2e | ✅ pass | 24s | chromium 64/65, webkit 62/65 |
| cargo_test | ✅ pass | 8s | 30 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 1s | clean |
| bundle | ✅ pass | 185s | Margin_0.1.0_amd64.AppImage (81.0 MB), Margin_0.1.0_amd64.deb (6.0 MB) |
| smoke | ✅ pass | 10s | window ok, screenshot stddev 0.377861 |

Wall time 204s (js and rust lanes run in parallel). Cache: node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.
