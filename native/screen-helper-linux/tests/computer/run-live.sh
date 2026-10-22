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
# Fresh app state each run: no restored drafts or remembered windows.
state=$(mktemp -d)
export XDG_DATA_HOME="$state/data" XDG_CONFIG_HOME="$state/config" XDG_STATE_HOME="$state/state" XDG_CACHE_HOME="$state/cache"
trap 'kill $xvfb 2>/dev/null; rm -rf "$state"' EXIT
export DISPLAY=":$display"
for _ in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
dbus-update-activation-environment DISPLAY >/dev/null 2>&1 || true
openbox >/dev/null 2>&1 &
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
sleep 0.5
python3 tests/computer/live.py "$PWD/target/debug/ace-screen-helper-linux"
