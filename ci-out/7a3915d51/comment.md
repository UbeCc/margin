### ✅ `dev_0911-ci` — 7a3915d51

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 291s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 475/475 tests |
| e2e | ✅ pass | 47s | chromium 137/138, webkit 135/138 |
| cargo_test | ✅ pass | 20s | 132 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 26s | clean |
| bundle | ✅ pass | 194s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377865 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 283s (js and rust lanes run in parallel). Cache: e2e port: 36647; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<sub>`scripts/ci-remote.sh 112` · logs in `ci-out/7a3915d51/` on the runner's checkout</sub>
