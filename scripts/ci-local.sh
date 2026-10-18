#!/usr/bin/env bash
# Margin local CI — run from the repo root inside the margin-linux image
# (docker/linux/Dockerfile). Each stage logs to ci-out/<stage>.log and records
# ci-out/<stage>.res (status, seconds). scripts/ci-report.mjs turns that plus the
# vitest/playwright JSON into ci-out/summary.md + summary.json.
#
#   bash scripts/ci-local.sh            # everything
#   bash scripts/ci-local.sh --quick    # skip tauri bundle + Xvfb smoke
#   CI_SKIP="clippy" bash scripts/ci-local.sh
#
# Stages run as two parallel lanes after `npm_ci`:
#   js:   typecheck → vitest → e2e (playwright chromium + webkit, one vite server)
#   rust: cargo_test → clippy → bundle (tauri build deb+appimage) → smoke (Xvfb)
# Caches shared by checkouts in the same container: /cache/npm, /cache/target
# (cargo target dir, serialized with flock).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/ci-out"
export ROOT OUT
rm -rf "$OUT"; mkdir -p "$OUT"

QUICK=0; [ "${1:-}" = "--quick" ] && QUICK=1
export CI=1
export npm_config_cache="${npm_config_cache:-/cache/npm}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/cache/target}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-16}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
# A private vite port per run (#75): a stale or parallel run can't take ours.
. "$ROOT/scripts/free-port.sh"
export E2E_PORT="${E2E_PORT:-$(free_port)}"
echo "e2e port: $E2E_PORT" >>"$OUT/cache.txt"
mkdir -p "$npm_config_cache" "$CARGO_TARGET_DIR" 2>/dev/null || true

SKIP=" ${CI_SKIP:-} "
[ $QUICK = 1 ] && SKIP="$SKIP bundle smoke native_qa "
OPTIONAL=" clippy "   # reported as warn, never fails the run
T_START=$SECONDS

# run_step <name> <fn>: returns non-zero if the stage failed (warn counts as ok).
run_step() {
  local name="$1" fn="$2"
  if [[ "$SKIP" == *" $name "* ]]; then echo "skip 0" >"$OUT/$name.res"; return 0; fi
  local t0=$SECONDS rc=0
  echo "::: $name start (+$((SECONDS - T_START))s)"
  # A fresh bash so errexit applies inside the stage (it is ignored in subshells
  # of `if`/`&&` contexts).
  bash -euo pipefail -c "$fn" >"$OUT/$name.log" 2>&1
  rc=$?
  local dt=$((SECONDS - t0)) st=pass
  if [ $rc -ne 0 ]; then
    st=fail; [[ "$OPTIONAL" == *" $name "* ]] && st=warn
  fi
  echo "$st $dt" >"$OUT/$name.res"
  echo "::: $name -> $st (${dt}s)"
  [ "$st" != fail ]
}

skip_rest() { for s in "$@"; do [ -f "$OUT/$s.res" ] || echo "blocked 0" >"$OUT/$s.res"; done; }

with_target_lock() { flock "$CARGO_TARGET_DIR/.ci.lock" "$@"; }

# --- stages ---------------------------------------------------------------
s_npm_ci() {
  # Cache hit: node_modules was installed from this exact lockfile.
  local want; want=$(sha256sum package-lock.json | cut -c1-16)
  if [ -f node_modules/.margin-lock ] && [ "$(cat node_modules/.margin-lock)" = "$want" ]; then
    echo "node_modules: hit (lock $want)" | tee -a "$OUT/cache.txt"; return 0
  fi
  echo "node_modules: miss (lock $want)" >>"$OUT/cache.txt"
  npm ci --no-audit --prefer-offline
  echo "$want" >node_modules/.margin-lock
}
s_typecheck() { npm run typecheck; }
s_vitest() { npx vitest run --reporter=default --reporter=json --outputFile="$OUT/vitest.json"; }
s_e2e() {
  PW_BROWSERS="${PW_BROWSERS:-chromium,webkit}" PW_JSON="$OUT/e2e.json" npx playwright test
}
s_cargo_test() {
  [ -d "$CARGO_TARGET_DIR/debug/deps" ] && echo "cargo debug target: warm" >>"$OUT/cache.txt" \
    || echo "cargo debug target: cold" >>"$OUT/cache.txt"
  [ -d dist ] || npm run build   # tauri::generate_context! wants ../dist
  cd src-tauri && with_target_lock cargo test --locked
}
s_clippy() { cd src-tauri && with_target_lock cargo clippy --locked --all-targets -- -D warnings; }
s_bundle() {
  [ -f "$CARGO_TARGET_DIR/release/margin" ] && echo "cargo release target: warm" >>"$OUT/cache.txt" \
    || echo "cargo release target: cold" >>"$OUT/cache.txt"
  local b="$CARGO_TARGET_DIR/release/bundle"
  rm -rf "$b/deb" "$b/appimage"
  with_target_lock npx tauri build --ci --bundles deb,appimage
  mkdir -p "$OUT/bundle"
  cp "$b"/deb/*.deb "$b"/appimage/*.AppImage "$OUT/bundle/"
  ls -la "$OUT/bundle"
  local deb; deb=$(ls "$OUT"/bundle/*.deb | head -1)
  dpkg-deb -I "$deb"
  # The .desktop file in the .deb must be valid and declare our MIME types.
  local tmp; tmp=$(mktemp -d); dpkg-deb -x "$deb" "$tmp"
  local desk; desk=$(find "$tmp/usr/share/applications" -name '*.desktop' | head -1)
  cat "$desk"
  desktop-file-validate "$desk"
  grep -q '^MimeType=.*text/markdown' "$desk"
  grep -q '^Exec=.* %[fFuU]' "$desk"   # file managers pass the clicked file
}
s_smoke() { bash "$ROOT/scripts/linux-smoke.sh" "$OUT"; }
# Native scenarios on the installed .deb (single instance, xdg-open, close veto, PDF
# fallback). Fails when any RESULT line says fail.
s_native_qa() {
  bash "$ROOT/scripts/linux-native-qa.sh" "$OUT" | tee "$OUT/native-qa.txt"
  ! grep -q '^RESULT [a-z_]* fail' "$OUT/native-qa.txt"
}

export -f with_target_lock s_npm_ci s_typecheck s_vitest s_e2e s_cargo_test s_clippy s_bundle s_smoke s_native_qa

# --- schedule -------------------------------------------------------------
if run_step npm_ci s_npm_ci; then
  (
    run_step typecheck s_typecheck
    run_step vitest s_vitest
    run_step e2e s_e2e
  ) &
  JS=$!
  (
    if run_step cargo_test s_cargo_test; then
      run_step clippy s_clippy
      run_step bundle s_bundle && run_step smoke s_smoke && run_step native_qa s_native_qa
    fi
    skip_rest clippy bundle smoke native_qa
  ) &
  RUST=$!
  wait $JS; wait $RUST
fi
skip_rest typecheck vitest e2e cargo_test clippy bundle smoke native_qa
echo "$((SECONDS - T_START))" >"$OUT/total-seconds"

node "$ROOT/scripts/ci-report.mjs" "$OUT"
