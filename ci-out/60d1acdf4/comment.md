### ✅ `dev_0911-ci` — 60d1acdf4

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 208s end to end.

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

<sub>`scripts/ci-remote.sh 39` · logs in `ci-out/60d1acdf4/` on the runner's checkout</sub>
