#!/bin/sh
# Live check of `ace-screen-helper-linux --computer` on a throwaway X11 desktop.
# Needs: Xvfb, openbox, at-spi2-core, dbus, gnome-text-editor, gnome-calculator, mousepad.
# Usage: tests/computer/run-live.sh [display-number]   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
display="${1:-93}"
if [ -z "${ACE_LIVE_SESSION:-}" ]; then
  ACE_LIVE_SESSION=1 exec dbus-run-session -- "$0" "$display"
fi
Xvfb ":$display" -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
xvfb=$!
trap 'kill $xvfb 2>/dev/null' EXIT
export DISPLAY=":$display"
for _ in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
dbus-update-activation-environment DISPLAY >/dev/null 2>&1 || true
openbox >/dev/null 2>&1 &
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
sleep 0.5
python3 tests/computer/live.py "$PWD/target/debug/ace-screen-helper-linux"
