### ✅ `dev_0911-ci` — 96668765e

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 1524s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 3s | 467/467 tests |
| e2e | ✅ pass | 44s | chromium 127/128, webkit 125/128 |
| cargo_test | ✅ pass | 20s | 131 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 26s | clean |
| bundle | ✅ pass | 190s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377865 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 279s (js and rust lanes run in parallel). Cache: e2e port: 46213; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<sub>`scripts/ci-remote.sh 112` · logs in `ci-out/96668765e/` on the runner's checkout</sub>
