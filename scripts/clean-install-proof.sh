#!/usr/bin/env bash
# Clean-install package proof for the parity ledger (REA package proof kind `clean-install`).
# Clones the committed HEAD of this repo into a fresh temp dir (no node_modules, no caches,
# no untracked files), then: npm ci (empty npm cache) → npm run build → npm test →
# cargo test (src-tauri, own target dir). Exit 0 only if every step passes.
# Usage: scripts/clean-install-proof.sh [<rev>]   (run under `rea capture-process` by
# scripts/parity-captures.mjs so the run is recorded as Evidence).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
rev="${1:-HEAD}"
sha="$(git -C "$repo" rev-parse "$rev")"
work="$(mktemp -d "${TMPDIR:-/tmp}/margin-clean-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT
echo "clean-install: $sha -> $work"
git clone --quiet --no-hardlinks "$repo" "$work/margin"
cd "$work/margin"
git checkout --quiet --detach "$sha"
test -z "$(git status --porcelain)"
test ! -e node_modules
echo "== npm ci"
npm ci --no-audit --no-fund --cache "$work/npm-cache" --loglevel=error
echo "== npm run build"
npm run build --silent
echo "== npm test"
npx vitest run --reporter=dot
echo "== cargo test"
(cd src-tauri && CARGO_TARGET_DIR="$work/target" cargo test --quiet)
echo "clean-install: PASS $sha"
