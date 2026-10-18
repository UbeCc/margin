### ✅ `dev_0911-ci` — 101df0a45

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 417s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 3s | 393/393 tests |
| e2e | ✅ pass | 32s | chromium 94/95, webkit 92/95 |
| cargo_test | ✅ pass | 15s | 93 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 2s | clean |
| bundle | ✅ pass | 192s | Margin_0.1.0_amd64.AppImage (81.2 MB), Margin_0.1.0_amd64.deb (6.2 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377864 |
| native_qa | ✅ pass | 31s | 11/13 pass |

Wall time 251s (js and rust lanes run in parallel). Cache: e2e port: 33883; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<sub>`scripts/ci-remote.sh 108` · logs in `ci-out/101df0a45/` on the runner's checkout</sub>
