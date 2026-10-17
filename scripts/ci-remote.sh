#!/usr/bin/env bash
# Run Margin CI for a commit on the Linux box (dev_0911) and report to GitHub.
#
#   scripts/ci-remote.sh <PR#|branch|sha> [--quick] [--no-post]
#
# 1. sets commit status `dev_0911-ci` = pending
# 2. ships `git archive <sha>` to $CI_HOST:$CI_DIR/runs/<sha>
# 3. runs scripts/ci-local.sh inside the long-lived margin-dev container
#    (one run at a time, host-side flock; node_modules + cargo target stay warm)
# 4. copies ci-out back to ./ci-out/<sha>/ (logs, summary, screenshots, bundles)
# 5. posts summary.md as a PR comment (or commit comment) + final status
#
# Env: CI_HOST (dev_0911), CI_DIR (/opt/margin-dev), REPO (UbeCc/margin),
#      CI_FETCH_BUNDLES=1 to also copy the .deb/.AppImage back.
set -euo pipefail

TARGET="${1:?usage: ci-remote.sh <PR#|branch|sha> [--quick] [--no-post]}"; shift
QUICK=""; POST=1
for a in "$@"; do case "$a" in --quick) QUICK=--quick ;; --no-post) POST=0 ;; *) echo "bad arg $a"; exit 2 ;; esac; done
HOST="${CI_HOST:-dev_0911}"; DIR="${CI_DIR:-/opt/margin-dev}"; REPO="${REPO:-UbeCc/margin}"
CTX="dev_0911-ci"
cd "$(git rev-parse --show-toplevel)"

PR=""
if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  PR="$TARGET"
  SHA=$(gh pr view "$PR" -R "$REPO" --json headRefOid -q .headRefOid)
  git fetch -q origin "pull/$PR/head" || true
else
  git fetch -q origin "$TARGET" 2>/dev/null || true
  SHA=$(git rev-parse --verify "origin/$TARGET^{commit}" 2>/dev/null || git rev-parse --verify "$TARGET^{commit}")
  PR=$(gh pr list -R "$REPO" --search "$SHA" --state open --json number -q '.[0].number' 2>/dev/null || true)
fi
SHORT=${SHA:0:9}
LOCAL_OUT="ci-out/$SHORT"
echo "ci-remote: $SHORT ${PR:+(PR #$PR)} on $HOST"

status() {  # state description
  [ $POST = 1 ] || return 0
  gh api -X POST "repos/$REPO/statuses/$SHA" -f state="$1" -f context="$CTX" -f description="$2" >/dev/null || true
}
status pending "running on $HOST${QUICK:+ (quick)}"

# Ship the tree (only committed content) and run.
git archive --format=tar "$SHA" | ssh "$HOST" "mkdir -p $DIR/runs/$SHORT && tar -C $DIR/runs/$SHORT -xf -"
T0=$SECONDS
set +e
ssh "$HOST" "cd $DIR/runs/$SHORT && flock $DIR/ci.lock bash scripts/linux-docker.sh ci . work $QUICK" \
  > >(tee "/tmp/margin-ci-$SHORT.log") 2>&1
RC=$?
set -e
WALL=$((SECONDS - T0))

rm -rf "$LOCAL_OUT"; mkdir -p "$LOCAL_OUT"
EXCL="--exclude bundle --exclude e2e-test-results"
[ "${CI_FETCH_BUNDLES:-0}" = 1 ] && EXCL=""
rsync -a $EXCL "$HOST:$DIR/runs/$SHORT/ci-out/" "$LOCAL_OUT/" 2>/dev/null || true
ssh "$HOST" "cd $DIR/runs && ls -1t | tail -n +6 | xargs -r rm -rf"   # keep the last 5 runs

if [ -f "$LOCAL_OUT/summary.md" ]; then
  ok=$(node -e "console.log(require('./$LOCAL_OUT/summary.json').ok)" 2>/dev/null || echo false)
else
  ok=false; printf 'CI did not produce a summary (exit %s). Last lines:\n```\n%s\n```\n' "$RC" \
    "$(tail -n 30 "/tmp/margin-ci-$SHORT.log")" >"$LOCAL_OUT/summary.md"
fi
[ "$RC" = 0 ] || ok=false
state=$([ "$ok" = true ] && echo success || echo failure)
desc=$(node -e "const s=require('./$LOCAL_OUT/summary.json');console.log(s.stages.map(x=>x.stage+':'+x.status).join(' ').slice(0,135))" 2>/dev/null || echo "exit $RC")

if [ $POST = 1 ]; then
  body="$LOCAL_OUT/comment.md"
  {
    echo "### $([ "$ok" = true ] && echo '✅' || echo '❌') \`$CTX\` — $SHORT${QUICK:+ (quick: no bundle/smoke)}"
    echo
    echo "Ubuntu 24.04 container (\`margin-linux:24.04\`, 16 CPUs) on $HOST; ${WALL}s end to end."
    echo
    cat "$LOCAL_OUT/summary.md"
    echo
    echo "<sub>\`scripts/ci-remote.sh ${PR:-$TARGET}\` · logs in \`ci-out/$SHORT/\` on the runner's checkout</sub>"
  } >"$body"
  if [ -n "$PR" ]; then gh pr comment "$PR" -R "$REPO" --body-file "$body" >/dev/null
  else gh api -X POST "repos/$REPO/commits/$SHA/comments" -F body=@"$body" >/dev/null; fi
fi
status "$state" "$desc"
echo "ci-remote: $state ($desc)"
[ "$ok" = true ]
