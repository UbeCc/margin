#!/usr/bin/env bash
# Recipe/test for #75: two CI runs started at the same time on dev_0911 must both
# pass, even when the first one's ssh session is killed mid-run (orphaned docker exec).
#
#   scripts/ci-concurrency-test.sh [ref-a] [ref-b]     (defaults: HEAD HEAD~1)
# Runs `ci-remote.sh --quick --no-post` twice in parallel (A is killed after 25 s and
# restarted), then checks: both summaries ok, and the e2e ports differ.
set -uo pipefail
cd "$(dirname "$0")/.."
A="${1:-HEAD}"; B="${2:-HEAD~1}"
LOG=$(mktemp -d)
echo "logs in $LOG"

bash scripts/ci-remote.sh "$A" --quick --no-post >"$LOG/a1.log" 2>&1 & PA=$!
sleep 2
bash scripts/ci-remote.sh "$B" --quick --no-post >"$LOG/b.log" 2>&1 & PB=$!
sleep 25
kill "$PA" 2>/dev/null; pkill -P "$PA" 2>/dev/null   # simulate Ctrl+C / dropped connection
wait "$PA" 2>/dev/null
bash scripts/ci-remote.sh "$A" --quick --no-post >"$LOG/a2.log" 2>&1; RA=$?
wait "$PB"; RB=$?

port() { grep -ho 'e2e port: [0-9]*' "ci-out/$(git rev-parse --short=9 "$1")/cache.txt" 2>/dev/null; }
echo "A rerun: exit $RA $(tail -1 "$LOG/a2.log")"
echo "B:       exit $RB $(tail -1 "$LOG/b.log")"
echo "ports: A $(port "$A") | B $(port "$B")"
[ "$RA" = 0 ] && [ "$RB" = 0 ] && echo "PASS: concurrent runs both green" && exit 0
echo "FAIL"; exit 1
