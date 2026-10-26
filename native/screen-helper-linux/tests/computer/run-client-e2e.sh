#!/bin/sh
# The daemon's real ComputerClient and screen_* tools against the Linux helper, on a
# throwaway X11 desktop with GNOME Calculator. Needs `bun install` at the repo root first.
# Usage: tests/computer/run-client-e2e.sh [display-number]   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
display="${1:-94}"
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
gnome-calculator >/dev/null 2>&1 &
sleep 3
# Another window takes focus, so Calculator is in the background as an agent usually finds it.
xterm >/dev/null 2>&1 &
sleep 1
node tests/computer/client-e2e.ts "$PWD/target/debug/ace-screen-helper-linux"
