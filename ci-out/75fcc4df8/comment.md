### ✅ `dev_0911-ci` — 75fcc4df8

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 446s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 4s | 490/490 tests |
| e2e | ✅ pass | 46s | chromium 136/137, webkit 134/137 |
| cargo_test | ✅ pass | 20s | 133 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 26s | clean |
| bundle | ✅ pass | 193s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377854 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 282s (js and rust lanes run in parallel). Cache: e2e port: 43681; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<sub>`scripts/ci-remote.sh 123` · logs in `ci-out/75fcc4df8/` on the runner's checkout</sub>
