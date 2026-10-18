### ❌ `dev_0911-ci` — d3798c2de

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 906s end to end.

CI did not produce a summary (exit 0). Last lines:
```
::: npm_ci -> pass (0s)
::: typecheck start (+0s)
::: cargo_test start (+0s)
::: typecheck -> pass (2s)
::: vitest start (+2s)
::: vitest -> pass (3s)
::: e2e start (+5s)
::: cargo_test -> pass (15s)
::: clippy start (+15s)
::: clippy -> pass (24s)
::: bundle start (+39s)
::: e2e -> pass (52s)
::: bundle -> pass (201s)
::: smoke start (+240s)
::: smoke -> pass (11s)
::: native_qa start (+251s)
::: native_qa -> pass (32s)
| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 2s |  |
| vitest | ✅ pass | 3s | 497/497 tests |
| e2e | ✅ pass | 52s | chromium 144/145, webkit 142/145 |
| cargo_test | ✅ pass | 15s | 130 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 24s | clean |
| bundle | ✅ pass | 201s | Margin_0.1.0_amd64.AppImage (81.3 MB), Margin_0.1.0_amd64.deb (6.3 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377864 |
| native_qa | ✅ pass | 32s | 11/13 pass |

Wall time 283s (js and rust lanes run in parallel). Cache: e2e port: 39661; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.
```

<sub>`scripts/ci-remote.sh 126` · logs in `ci-out/d3798c2de/` on the runner's checkout</sub>
