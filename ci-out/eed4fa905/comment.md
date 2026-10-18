### ❌ `dev_0911-ci` — eed4fa905

Ubuntu 24.04 container (`margin-linux:24.04`, 16 CPUs) on dev_0911; 383s end to end.

| stage | result | time | notes |
| --- | --- | --- | --- |
| npm_ci | ✅ pass | 0s |  |
| typecheck | ✅ pass | 1s |  |
| vitest | ✅ pass | 3s | 338/338 tests |
| e2e | ✅ pass | 25s | chromium 68/69, webkit 66/69 |
| cargo_test | ✅ pass | 10s | 88 passed, 0 failed / 0 passed, 0 failed / 0 passed, 0 failed |
| clippy | ✅ pass | 1s | clean |
| bundle | ✅ pass | 187s | Margin_0.1.0_amd64.AppImage (81.2 MB), Margin_0.1.0_amd64.deb (6.2 MB) |
| smoke | ✅ pass | 11s | window ok, screenshot stddev 0.377865 |
| native_qa | ❌ fail | 18s | 8/10 pass; failed: pdf_fallback |

Wall time 227s (js and rust lanes run in parallel). Cache: e2e port: 38733; node_modules: hit (lock 975215959a357a01); cargo debug target: warm; cargo release target: warm.

<details><summary>native_qa log tail</summary>

```
RESULT deb_install pass Margin_0.1.0_amd64.deb
/usr/share/applications/Margin.desktop: warning: value "text/markdown;text/markdown;text/plain" for key "MimeType" in group "Desktop Entry" contains "text/markdown" more than once
RESULT mime_default pass Margin.desktop
RESULT first_launch pass a.md — notes
RESULT single_instance_cli pass rc=0 procs=1
RESULT single_instance_relative pass 
RESULT xdg_open pass procs=1
RESULT close_veto pass still running after Ctrl+Q with unsaved text
RESULT pdf_fallback fail no print/export dialog (see qa-pdf.png)
RESULT no_hang_after_pdf pass 
RESULT inotify_limit skip max_user_watches=524288 not writable in this container
```
</details>

<sub>`scripts/ci-remote.sh 43` · logs in `ci-out/eed4fa905/` on the runner's checkout</sub>
