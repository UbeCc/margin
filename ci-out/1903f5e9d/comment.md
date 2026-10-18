### ✅ `dev_0911-ci` — 1903f5e9d (quick: no bundle/smoke)

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 37s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 3s | 393/393 tests |
| e2e | ✅ pass | 31s | chromium 94/95, webkit 92/95 |
| cargo_test | ✅ pass | 10s | 93 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 1s | clean |
| bundle | ⏭️ skip | 0s |  |
| smoke | ⏭️ skip | 0s |  |
| native_qa | ⏭️ skip | 0s | 0/0 pass |

Wall time 36s (js and rust lanes run in parallel). Cache: e2e port: 43115; node_modules: hit (lock 975215959a357a01); cargo debug target: warm.

<sub>`scripts/ci-remote.sh 85` · logs in `ci-out/1903f5e9d/` on the runner's checkout</sub>
