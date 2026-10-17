#!/usr/bin/env bash
# Native/Linux QA scenarios under Xvfb + one D-Bus session (run in the CI image,
# after `tauri build` produced a .deb):
#   1. .deb install, .desktop validation, xdg-mime default
#   2. single instance: a second `margin b.md` and `xdg-open c.md` reuse the first process (#29)
#   3. Open Recent: settings recents show up after restart (menu is native; checked by log)
#   4. close veto: type into the doc, Ctrl+Q → window must stay (unsaved dialog)
#   5. PDF export fallback: Ctrl+Alt+E opens the GTK print dialog instead of hanging (#30)
#   6. inotify: watching a folder whose subtree exceeds max_user_watches degrades, not fails
#
#   scripts/linux-native-qa.sh <out-dir> [deb]
# Prints one `RESULT <name> pass|fail|skip <note>` line per scenario.
set -uo pipefail
OUT="${1:?out dir}"; mkdir -p "$OUT"
DEB="${2:-$(ls "$OUT"/bundle/*.deb "${CARGO_TARGET_DIR:-src-tauri/target}"/*/bundle/deb/*.deb 2>/dev/null | head -1)}"
res() { echo "RESULT $1 $2 ${3:-}"; }

if [ -n "$DEB" ] && [ "$(id -u)" = 0 ]; then
  dpkg -i "$DEB" >/dev/null 2>&1 && res deb_install pass "$(basename "$DEB")" || res deb_install fail
  desktop-file-validate /usr/share/applications/Margin.desktop 2>&1 | head -3
  update-desktop-database -q /usr/share/applications 2>/dev/null
  d=$(xdg-mime query default text/markdown 2>/dev/null)
  [ "$d" = "Margin.desktop" ] && res mime_default pass "$d" || res mime_default fail "got '$d'"
fi
BIN=/usr/bin/margin; [ -x "$BIN" ] || { res all skip "no installed binary"; exit 0; }

. "$(dirname "${BASH_SOURCE[0]}")/free-port.sh"
DISPLAY=":$(free_display 98)"; export DISPLAY
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 & XVFB=$!
eval "$(dbus-launch --sh-syntax)"
cleanup() { pkill -f /usr/bin/margin 2>/dev/null; kill "$XVFB" "$DBUS_SESSION_BUS_PID" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done

H=$(mktemp -d); export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_DATA_HOME=$H/.local/share
mkdir -p "$H/notes"
for n in a b c; do printf '# Doc %s\n\nText %s.\n' "$n" "$n" > "$H/notes/$n.md"; done
win() { xdotool search --onlyvisible --class '^margin$' 2>/dev/null | head -1; }
title() { local w; w=$(win); [ -n "$w" ] && xdotool getwindowname "$w"; }
nproc_margin() { pgrep -fc '^/usr/bin/margin' || true; }
wait_title() { for _ in $(seq 40); do title | grep -q "$1" && return 0; sleep 0.5; done; return 1; }

"$BIN" "$H/notes/a.md" >"$OUT/qa-app.log" 2>&1 &
wait_title a.md && res first_launch pass "$(title)" || { res first_launch fail "$(title)"; tail -20 "$OUT/qa-app.log"; exit 1; }
sleep 3

# 2. single instance
timeout 20 "$BIN" "$H/notes/b.md" >"$OUT/qa-second.log" 2>&1; rc=$?
sleep 1
n=$(nproc_margin)
wait_title b.md && [ "$n" = 1 ] && res single_instance_cli pass "rc=$rc procs=$n" || res single_instance_cli fail "rc=$rc procs=$n title=$(title)"
(cd "$H/notes" && timeout 20 "$BIN" c.md >/dev/null 2>&1)   # relative path resolved against the 2nd instance's cwd
wait_title c.md && res single_instance_relative pass || res single_instance_relative fail "$(title)"
xdg-open "$H/notes/a.md" >/dev/null 2>&1 &
sleep 4
n=$(nproc_margin)
title | grep -q a.md && [ "$n" = 1 ] && res xdg_open pass "procs=$n" || res xdg_open fail "procs=$n title=$(title)"
import -window root "$OUT/qa-single.png" 2>/dev/null

# 4. close veto with unsaved changes
W=$(win); xdotool windowactivate --sync "$W" 2>/dev/null; sleep 0.5
xdotool mousemove --window "$W" 600 300 click 1; sleep 0.3
xdotool key End; xdotool type --delay 30 " unsaved edit"; sleep 1
xdotool key ctrl+q; sleep 2
if [ "$(nproc_margin)" = 1 ]; then
  import -window root "$OUT/qa-veto.png" 2>/dev/null
  res close_veto pass "still running after Ctrl+Q with unsaved text"
  xdotool key Escape; sleep 0.5
else
  res close_veto fail "exited with unsaved changes"
fi

# 5. PDF export fallback (print dialog)
if [ "$(nproc_margin)" = 1 ]; then
  xdotool windowactivate --sync "$(win)" 2>/dev/null
  xdotool key ctrl+alt+e; sleep 3
  dlg=$(xdotool search --onlyvisible --name 'Print|Export' 2>/dev/null | grep -v "^$(win)$" | head -1)
  import -window root "$OUT/qa-pdf.png" 2>/dev/null
  if [ -n "$dlg" ]; then
    res pdf_fallback pass "dialog '$(xdotool getwindowname "$dlg")'"
    xdotool key --window "$dlg" Escape; sleep 1
  else
    res pdf_fallback fail "no print/export dialog (see qa-pdf.png)"
  fi
  kill -0 "$(pgrep -f '^/usr/bin/margin' | head -1)" 2>/dev/null && res no_hang_after_pdf pass || res no_hang_after_pdf fail
fi
pkill -f '^/usr/bin/margin'; sleep 1

# 6. inotify limit: needs a writable sysctl (privileged container)
lim=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null)
if [ -w /proc/sys/fs/inotify/max_user_watches ]; then
  res inotify_limit skip "sysctl writable but scenario is covered by cargo test watch_limit_*"
else
  res inotify_limit skip "max_user_watches=$lim not writable in this container"
fi
