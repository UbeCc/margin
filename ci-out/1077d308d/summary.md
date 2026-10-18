| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 1s |  |
| vitest | ✅ pass | 3s | 338/338 tests |
| e2e | ✅ pass | 24s | chromium 68/69, webkit 66/69 |
| cargo_test | ✅ pass | 10s | 88 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 0s | clean |
| bundle | ⏭️ skip | 0s |  |
| smoke | ⏭️ skip | 0s |  |

Wall time 28s (js and rust lanes run in parallel). Cache: e2e port: 34893; node_modules: hit (lock 975215959a357a01); cargo debug target: warm.
