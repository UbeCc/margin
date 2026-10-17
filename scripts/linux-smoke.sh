#!/usr/bin/env bash
# Headless smoke run of the Linux build under Xvfb:
#   install the .deb (when root), launch Margin with a sample document, wait for its
#   window, screenshot it, open the File menu (F10) and screenshot again, check the
#   process survived, quit.
#
#   scripts/linux-smoke.sh <out-dir> [binary]
# Output: <out-dir>/smoke.png, smoke-menu.png, smoke-app.log, smoke.note
set -uo pipefail

OUT="${1:?out dir}"; mkdir -p "$OUT"
BIN="${2:-}"
TARGET="${CARGO_TARGET_DIR:-src-tauri/target}"
LOG="$OUT/smoke-app.log"

if [ -z "$BIN" ]; then
  deb=$(ls "$OUT"/bundle/*.deb "$TARGET"/release/bundle/deb/*.deb 2>/dev/null | head -1)
  if [ -n "$deb" ] && [ "$(id -u)" = 0 ]; then
    dpkg -i "$deb" >/dev/null && BIN=/usr/bin/margin && echo "installed $(basename "$deb")"
    # File associations registered by the package:
    update-desktop-database -q /usr/share/applications 2>/dev/null || true
    echo "xdg-mime default for text/markdown: $(xdg-mime query default text/markdown 2>/dev/null)"
  fi
  [ -z "$BIN" ] && BIN="$TARGET/release/margin"
fi
[ -x "$BIN" ] || { echo "no binary at $BIN"; exit 1; }

export DISPLAY=:99
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
trap 'kill $APP $XVFB 2>/dev/null; wait 2>/dev/null' EXIT
for _ in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done

HOME_DIR=$(mktemp -d); export HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config"
DOC="$HOME_DIR/Smoke.md"
cat >"$DOC" <<'EOF'
# Margin on Linux

Smoke test document with **bold**, _emphasis_, `code` and 中文.

- [x] launched under Xvfb
- [ ] more to come

```js
console.log("hello")
```
EOF

dbus-run-session -- "$BIN" "$DOC" >"$LOG" 2>&1 &
APP=$!
WIN=""
for _ in $(seq 60); do
  WIN=$(xdotool search --onlyvisible --name 'Margin' 2>/dev/null | head -1)
  [ -n "$WIN" ] && break
  kill -0 $APP 2>/dev/null || break
  sleep 0.5
done
if [ -z "$WIN" ]; then
  echo "no Margin window appeared"; import -window root "$OUT/smoke.png" 2>/dev/null
  tail -40 "$LOG"; exit 1
fi
echo "window $WIN: $(xdotool getwindowname "$WIN")"
sleep "${SMOKE_SETTLE:-6}"
import -window root "$OUT/smoke.png"
# A rendered window is not a flat colour.
SD=$(convert "$OUT/smoke.png" -colorspace gray -format '%[fx:standard_deviation]' info:)
echo "screenshot stddev=$SD"

# Open the first menu (GTK menubar, F10) to show accelerator labels (Ctrl, not Cmd).
xdotool windowactivate --sync "$WIN" 2>/dev/null || xdotool windowfocus "$WIN" 2>/dev/null
xdotool key --window "$WIN" F10; sleep 1
import -window root "$OUT/smoke-menu.png"
xdotool key Escape; sleep 0.5

kill -0 $APP 2>/dev/null || { echo "app exited early"; tail -40 "$LOG"; exit 1; }
xdotool key --window "$WIN" ctrl+q; sleep 2
if kill -0 $APP 2>/dev/null; then echo "still running after Ctrl+Q (close guard?), terminating"; kill $APP; fi
wait $APP 2>/dev/null
grep -iE 'panic|segfault|critical' "$LOG" && { echo "errors in app log"; exit 1; }
awk -v sd="$SD" 'BEGIN { exit !(sd > 0.02) }' || { echo "screenshot looks blank"; exit 1; }
echo "window ok, screenshot stddev $SD" >"$OUT/smoke.note"
echo "smoke ok"
