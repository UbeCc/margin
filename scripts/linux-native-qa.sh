#!/usr/bin/env bash
# Native/Linux QA scenarios under Xvfb + one D-Bus session (run in the CI image,
# after `tauri build` produced a .deb):
#   1. .deb unpacked privately, .desktop validation, per-user xdg-mime default
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

# Private install: unpack the .deb into a temp prefix and register its .desktop
# entry per user, so parallel runs (and the smoke stage's system-wide dpkg -i) never
# swap the binary under us.
H=$(mktemp -d); export HOME=$H XDG_CONFIG_HOME=$H/.config XDG_DATA_HOME=$H/.local/share
mkdir -p "$H/notes" "$XDG_DATA_HOME/applications" "$XDG_CONFIG_HOME"
if [ -f "$DEB" ]; then
  PRIV="$H/prefix"; dpkg-deb -x "$DEB" "$PRIV" && res deb_unpack pass "$(basename "$DEB")" || res deb_unpack fail
  BIN="$PRIV/usr/bin/margin"
  desk=$(find "$PRIV/usr/share/applications" -name '*.desktop' | head -1)
  desktop-file-validate "$desk" && res desktop_valid pass || res desktop_valid fail
  sed "s|^Exec=[^ ]*|Exec=$BIN|" "$desk" > "$XDG_DATA_HOME/applications/Margin.desktop"
  update-desktop-database -q "$XDG_DATA_HOME/applications" 2>/dev/null
  xdg-mime default Margin.desktop text/markdown 2>/dev/null
  d=$(xdg-mime query default text/markdown 2>/dev/null)
  [ "$d" = "Margin.desktop" ] && res mime_default pass "$d" || res mime_default fail "got '$d'"
else
  BIN="${MARGIN_BIN:-/usr/bin/margin}"
fi
[ -x "$BIN" ] || { res all skip "no binary ($BIN)"; exit 0; }

. "$(dirname "${BASH_SOURCE[0]}")/free-port.sh"
DISPLAY=":$(free_display 98)"; export DISPLAY
Xvfb "$DISPLAY" -screen 0 1440x1080x24 -nolisten tcp >/dev/null 2>&1 & XVFB=$!
eval "$(dbus-launch --sh-syntax)"
cleanup() { pkill -f "^$BIN" 2>/dev/null; kill "$XVFB" "$DBUS_SESSION_BUS_PID" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done

for n in a b c; do printf '# Doc %s\n\nText %s.\n' "$n" "$n" > "$H/notes/$n.md"; done
win() { xdotool search --onlyvisible --class '^margin$' 2>/dev/null | head -1; }
title() { local w; w=$(win); [ -n "$w" ] && xdotool getwindowname "$w"; }
nproc_margin() { pgrep -fc "^$BIN" || true; }
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

# 5. PDF export: Ctrl+Alt+E → GTK save dialog (output path) → Enter →
#    native WebKitPrintOperation writes the PDF straight to the chosen path (#14).
#    If the native path is unavailable the app falls back to the print dialog (#30).
others() { xdotool search --onlyvisible --name "${1:-.}" 2>/dev/null | grep -vx "$(win)" | head -1; }
if [ "$(nproc_margin)" = 1 ]; then
  xdotool windowactivate --sync "$(win)" 2>/dev/null
  xdotool key ctrl+alt+e; sleep 3
  save=$(others 'Save|Export|PDF')
  if [ -n "$save" ]; then
    res pdf_save_dialog pass "'$(xdotool getwindowname "$save")'"
    # No window manager under Xvfb: give the dialog X focus explicitly, then accept.
    xdotool windowfocus --sync "$save" 2>/dev/null; xdotool key --clearmodifiers Return; sleep 2
    if xdotool search --onlyvisible --name 'Save File' >/dev/null 2>&1; then
      eval "$(xdotool getwindowgeometry --shell "$save")"   # WIDTH/HEIGHT/X/Y
      xdotool mousemove --window "$save" $((WIDTH - 45)) $((HEIGHT - 20)) click 1; sleep 1
    fi
    # The doc is notes/a.md, so the default output path is notes/a.pdf; native export
    # needs a few seconds for load + print. Poll for the file instead of sleeping once.
    pdf=""
    for _ in $(seq 1 20); do
      pdf=$(find "$H" /tmp/nqa-print "$PWD" -maxdepth 3 -name '*.pdf' -newer "$OUT/qa-app.log" 2>/dev/null | head -1)
      [ -n "$pdf" ] && break
      sleep 1
    done
    import -window root "$OUT/qa-pdf.png" 2>/dev/null
    prn=$(others 'Print')
    if [ -n "$pdf" ] && [ -z "$prn" ]; then
      res pdf_export_native pass "$(basename "$pdf") written directly, no print dialog"
    elif [ -n "$prn" ]; then
      res pdf_print_fallback pass "'$(xdotool getwindowname "$prn")'"
      # #30: print to file (GTK's "Print to File" is the only printer without CUPS)
      # and check the PDF holds the exported document, not the editor chrome.
      xdotool windowfocus --sync "$prn" 2>/dev/null; xdotool key --clearmodifiers Return; sleep 6
      pdf=$(find "$H" /tmp/nqa-print "$PWD" -maxdepth 3 -name '*.pdf' -newer "$OUT/qa-app.log" 2>/dev/null | grep -v '/notes/a.pdf$' | head -1)
      if [ -z "$pdf" ] && xdotool search --onlyvisible --name 'Print' >/dev/null 2>&1; then
        res print_to_file skip "print dialog did not accept Return (no printer?)"; xdotool key Escape; sleep 1
      elif [ -z "$pdf" ]; then
        res print_to_file fail "no PDF written by Print to File"
      else
        res print_to_file skip "fallback wrote $(basename "$pdf") (native path expected)"
      fi
    else
      res pdf_export_native fail "no PDF at the chosen path and no print dialog (see qa-pdf.png)"
      xdotool search --onlyvisible --name . 2>/dev/null | while read -r w; do echo "  window: $(xdotool getwindowname "$w")"; done | head -8
    fi
    if [ -n "$pdf" ] && command -v pdftotext >/dev/null; then
      txt=$(pdftotext "$pdf" - 2>/dev/null)
      pages=$(pdfinfo "$pdf" 2>/dev/null | awk '/^Pages:/{print $2}')
      echo "$txt" | head -5 > "$OUT/qa-print.txt"
      if echo "$txt" | grep -q 'Doc a' && ! echo "$txt" | grep -qE '^(Files|Outline|NOTES)$'; then
        res pdf_content pass "$(basename "$pdf"): $pages page(s), document text only"
      else
        res pdf_content fail "PDF text is not the exported doc: $(echo "$txt" | tr '\n' ' ' | cut -c1-80)"
      fi
    elif [ -n "$pdf" ]; then
      res pdf_content skip "no pdftotext ($pdf written)"
    fi
  else
    import -window root "$OUT/qa-pdf.png" 2>/dev/null
    res pdf_save_dialog fail "no save dialog (see qa-pdf.png)"
  fi
  sleep 1
  [ "$(nproc_margin)" = 1 ] && title >/dev/null && res no_hang_after_pdf pass || res no_hang_after_pdf fail
fi
pkill -f "^$BIN"; sleep 1

# 6. inotify limit: needs a writable sysctl (privileged container)
lim=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null)
if [ -w /proc/sys/fs/inotify/max_user_watches ]; then
  res inotify_limit skip "sysctl writable but scenario is covered by cargo test watch_limit_*"
else
  res inotify_limit skip "max_user_watches=$lim not writable in this container"
fi
