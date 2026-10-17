# Linux build, test and CI

Margin is built, tested and smoke-run on Linux inside one Docker image. There is
no GitHub Actions workflow: CI runs on the shared Linux box `dev_0911` and reports
back to GitHub as a PR comment plus a commit status named `dev_0911-ci`.

## The image

`margin-linux:24.04` (Ubuntu 24.04; `--base ubuntu:22.04` also works) contains:

- Tauri v2 Linux deps: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf`
- build-essential, Rust stable (+clippy, rustfmt), Node 24
- Playwright 1.64.1 Chromium + WebKit with their system deps (must match `package-lock.json`)
- Xvfb, dbus-x11, xdotool, ImageMagick (`import`) for the headless smoke run
- `desktop-file-utils`, `xdg-utils`, Noto CJK fonts

All provisioning lives in `provision.sh`; the `Dockerfile` just runs it. Docker
hosts without a build API (dev_0911's Docker is a proxy: no `docker build`, no bind
mounts, no volumes, no `ENV` on commit) use run + exec + commit instead, which
`scripts/linux-docker.sh image` falls back to automatically. Runtime env defaults are
in `/etc/margin-ci.env` and get passed with `--env-file` when the container starts.

```sh
scripts/linux-docker.sh image --proxy           # build margin-linux:24.04 (forwards http(s)_proxy)
scripts/linux-docker.sh up                      # long-lived container `margin-dev` (16 CPUs, 32 GB)
scripts/linux-docker.sh sync . /work            # copy the tree in (keeps node_modules, src-tauri/target)
scripts/linux-docker.sh exec 'npm ci && npm test'
scripts/linux-docker.sh shell
```

Sources go in and results come out through `docker exec -i tar` and `docker cp`, so
nothing GUI-related is installed on the host.

## CI

From a Mac checkout with `gh` logged in:

```sh
scripts/ci-remote.sh 25            # PR number, branch or sha
scripts/ci-remote.sh master --quick   # skip tauri bundle + Xvfb smoke
scripts/ci-remote.sh 25 --no-post     # don't touch GitHub
```

`ci-remote.sh` sets `dev_0911-ci` to pending, ships `git archive <sha>` to
`dev_0911:/opt/margin-dev/runs/<sha>`, runs `scripts/ci-local.sh` in the container
(one run at a time, host-side `flock`), copies `ci-out/` back to `./ci-out/<sha>/`
and posts the summary table (plus log tails of failed stages) as a PR comment.

`scripts/ci-local.sh` (also usable directly inside any container from this image):

| lane | stages |
| --- | --- |
| first | `npm_ci` (skipped when `node_modules` was installed from the same lockfile) |
| js | `typecheck` → `vitest` → `e2e` (Playwright Chromium + WebKit, 6 workers, 1 retry) |
| rust | `cargo_test` → `clippy -D warnings` (warn only) → `bundle` (`tauri build --bundles deb,appimage`, validates the `.desktop` file) → `smoke` |

The lanes run in parallel. Caches stay inside the container: `/ci/work/node_modules`,
`/cache/npm` and `/cache/target` (a shared cargo target dir). Typical wall time with
warm caches: about 1 min for `--quick`, about 4 min for a full run. Most of the full
run is the LTO release link.

`scripts/linux-smoke.sh` installs the `.deb`, starts Margin under Xvfb with a sample
document, waits for its window, takes `smoke.png`, opens the File menu (F10) for
`smoke-menu.png`, quits with Ctrl+Q and fails on a crash, a panic in the log or a
blank screenshot.

## Being a good citizen on dev_0911

- Everything lives in `/opt/margin-dev/` and in containers named `margin-*`. Don't
  touch other containers, tmux sessions or `/opt/rea*`.
- The container is capped at 16 CPUs / 32 GB. `CARGO_BUILD_JOBS=16`, and Playwright
  uses 6 workers (`nproc` reports the host's 64 cores).
- `ci-remote.sh` keeps only the last 5 run directories.
