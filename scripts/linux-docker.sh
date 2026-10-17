#!/usr/bin/env bash
# Margin Linux container helper. Runs on a Linux host with Docker (e.g. dev_0911).
# No bind mounts are needed (some Docker proxies refuse them): sources go in and
# results come out through `docker exec -i tar` / `docker cp`.
#
#   scripts/linux-docker.sh image [--proxy] [--base ubuntu:22.04] [--commit]
#                                               build the image (falls back to run+exec+commit)
#   scripts/linux-docker.sh up                  start the long-lived dev container
#   scripts/linux-docker.sh sync <dir> <dest>   copy <dir> (no node_modules/target/dist) to <dest> in the container
#   scripts/linux-docker.sh exec <cmd...>       run a command in the container (cwd /work)
#   scripts/linux-docker.sh shell               interactive bash
#   scripts/linux-docker.sh pull <src> <dest>   docker cp out of the container
#   scripts/linux-docker.sh ci <dir> <ref>      sync <dir> → /ci/<ref>, run scripts/ci-local.sh, copy /ci/<ref>/ci-out back to <dir>/ci-out
#   scripts/linux-docker.sh snapshot            commit the container (with /cache) as <image>:warm
#   scripts/linux-docker.sh down                remove the container
#
# Env: MARGIN_IMAGE (margin-linux:24.04), MARGIN_CONTAINER (margin-dev),
#      MARGIN_CPUS (16), MARGIN_MEMORY (32g).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${MARGIN_IMAGE:-margin-linux:24.04}"
CTR="${MARGIN_CONTAINER:-margin-dev}"
CPUS="${MARGIN_CPUS:-16}"
MEM="${MARGIN_MEMORY:-32g}"

die() { echo "linux-docker: $*" >&2; exit 1; }

running() { [ "$(docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null || true)" = "true" ]; }

cmd_image() {
  local base="ubuntu:24.04" proxy=() mode="${MARGIN_IMAGE_MODE:-auto}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --proxy)
        # Forward the host proxy without echoing it.
        for v in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
          [ -n "${!v:-}" ] && proxy+=("$v")
        done ;;
      --base) base="$2"; shift ;;
      --commit) mode=commit ;;
      *) die "unknown image option $1" ;;
    esac
    shift
  done
  local tag="${IMAGE%%:*}:${base#*:}"
  if [ "$mode" != commit ]; then
    local bargs=(); for v in "${proxy[@]}"; do bargs+=(--build-arg "$v"); done
    if docker build "${bargs[@]}" --build-arg "BASE=$base" -t "$tag" "$HERE/docker/linux"; then return 0; fi
    [ "$mode" = build ] && die "docker build failed"
    echo "docker build unavailable; falling back to run + exec + commit" >&2
  fi
  # Docker proxies without a build API (e.g. dev_0911): provision a container, commit it.
  local tmp="margin-provision-$$" eargs=()
  for v in "${proxy[@]}"; do eargs+=(-e "$v"); done
  docker rm -f "$tmp" >/dev/null 2>&1 || true
  docker run -d --name "$tmp" --cpus "$CPUS" --memory "$MEM" "$base" sleep infinity >/dev/null
  trap 'docker rm -f "'"$tmp"'" >/dev/null 2>&1' RETURN
  docker cp "$HERE/docker/linux/provision.sh" "$tmp:/provision.sh"
  docker exec "${eargs[@]}" "$tmp" bash /provision.sh
  docker exec "$tmp" rm -f /provision.sh
  docker commit "$tmp" "$tag"
  echo "built $tag (commit mode)"
}

cmd_up() {
  if running; then return 0; fi
  docker rm -f "$CTR" >/dev/null 2>&1 || true
  local envf; envf=$(mktemp); docker run --rm "$IMAGE" cat /etc/margin-ci.env >"$envf"
  docker run -d --name "$CTR" --cpus "$CPUS" --memory "$MEM" --shm-size 2g \
    --env-file "$envf" --label margin=dev "$IMAGE" sleep infinity >/dev/null
  rm -f "$envf"
  docker exec "$CTR" mkdir -p /work /ci /cache/npm /cache/target
  echo "container $CTR up ($IMAGE, cpus=$CPUS, mem=$MEM)"
}

cmd_sync() {
  local src="${1:?dir}" dest="${2:-/work}"
  running || cmd_up
  docker exec "$CTR" sh -c "mkdir -p '$dest' && find '$dest' -mindepth 1 -maxdepth 1 \
    ! -name node_modules ! -name src-tauri ! -name ci-out -exec rm -rf {} + ; \
    if [ -d '$dest/src-tauri' ]; then find '$dest/src-tauri' -mindepth 1 -maxdepth 1 ! -name target -exec rm -rf {} + ; fi"
  tar -C "$src" --exclude=./node_modules --exclude=./src-tauri/target --exclude=./dist \
      --exclude=./ci-out --exclude=./test-results --exclude=./playwright-report -cf - . \
    | docker exec -i "$CTR" tar -C "$dest" -xf - --no-same-owner
}

cmd_exec() {
  running || cmd_up
  docker exec -w /work "$CTR" bash -lc "$*"
}

cmd_ci() {
  local src="${1:?dir}" ref="${2:?ref}" dest
  dest="/ci/$(echo "$ref" | tr -c 'A-Za-z0-9._-' '_')"
  cmd_sync "$src" "$dest"
  local rc=0
  docker exec -w "$dest" -e CI=1 "$CTR" bash scripts/ci-local.sh || rc=$?
  rm -rf "$src/ci-out"
  docker cp "$CTR:$dest/ci-out" "$src/ci-out" >/dev/null 2>&1 || true
  return $rc
}

case "${1:-}" in
  image) shift; cmd_image "$@" ;;
  up) cmd_up ;;
  sync) shift; cmd_sync "$@" ;;
  exec) shift; cmd_exec "$@" ;;
  shell) running || cmd_up; docker exec -it -w /work "$CTR" bash ;;
  pull) shift; docker cp "$CTR:${1:?src}" "${2:?dest}" ;;
  ci) shift; cmd_ci "$@" ;;
  snapshot) docker commit "$CTR" "${IMAGE%%:*}:warm" ;;  # keep warm caches if the container must be recreated
  down) docker rm -f "$CTR" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
