### ✅ `dev_0911-ci` — 56b020bf9

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 488s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 450/450 tests |
| e2e | ✅ pass | 39s | chromium 119/120, webkit 117/120 |
| cargo_test | ✅ pass | 10s | 108 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 28s | clean |
| bundle | ✅ pass | 136s | Margin_0.1.0_amd64.AppImage (81.2 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377866 |
| native_qa | ✅ pass | 31s | 11/13 pass |

Wall time 216s (js and rust lanes run in parallel). Cache: e2e port: 41055; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<sub>`scripts/ci-remote.sh 109` · logs in `ci-out/56b020bf9/` on the runner's checkout</sub>
