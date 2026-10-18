### ✅ `dev_0911-ci` — f4c959d1f

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 396s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 2s | 246/246 tests |
| e2e | ✅ pass | 24s | chromium 55/56, webkit 54/56 |
| cargo_test | ✅ pass | 32s | 88 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ⚠️ warn | 7s | 2 diagnostics |
| bundle | ✅ pass | 199s | Margin_0.1.0_amd64.AppImage (81.2 MB), Margin_0.1.0_amd64.deb (6.2 MB) |
| smoke | ✅ pass | 10s | window ok, screenshot stddev 0.377864 |

Wall time 248s (js and rust lanes run in parallel). Cache: node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<sub>`scripts/ci-remote.sh 43` · logs in `ci-out/f4c959d1f/` on the runner's checkout</sub>
