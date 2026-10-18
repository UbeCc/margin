### ✅ `dev_0911-ci` — 146dee3b6

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 691s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 478/478 tests |
| e2e | ✅ pass | 59s | chromium 147/148, webkit 145/148, 1 flaky |
| cargo_test | ✅ pass | 20s | 132 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 25s | clean |
| bundle | ✅ pass | 195s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377861 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 283s (js and rust lanes run in parallel). Cache: e2e port: 46409; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<sub>`scripts/ci-remote.sh 120` · logs in `ci-out/146dee3b6/` on the runner's checkout</sub>
