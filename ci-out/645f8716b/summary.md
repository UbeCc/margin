| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 3s | 459/459 tests |
| e2e | ✅ pass | 36s | chromium 109/110, webkit 107/110 |
| cargo_test | ✅ pass | 19s | 128 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ⚠️ warn | 25s | 2 diagnostics |
| bundle | ✅ pass | 187s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377862 |
| native_qa | ✅ pass | 31s | 11/13 pass |

Wall time 273s (js and rust lanes run in parallel). Cache: e2e port: 35061; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.
