#!/bin/sh
# Live check of `--computer` in a headless GNOME Shell Wayland session.
# Needs: gnome-shell, at-spi2-core, dbus, gnome-calculator, gnome-text-editor, mousepad.
# Usage: tests/computer/run-wayland.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
if [ -z "${ACE_LIVE_SESSION:-}" ]; then
  ACE_LIVE_SESSION=1 exec dbus-run-session -- "$0"
fi
name="ace-computer-$$"
unset DISPLAY
export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME GDK_BACKEND=wayland
gnome-shell --headless --wayland --no-x11 --wayland-display="$name" --virtual-monitor 1280x800 >/dev/null 2>&1 &
shell=$!
trap 'kill $shell 2>/dev/null' EXIT
for _ in $(seq 100); do [ -S "$XDG_RUNTIME_DIR/$name" ] && break; sleep 0.1; done
export WAYLAND_DISPLAY="$name"
dbus-update-activation-environment WAYLAND_DISPLAY XDG_SESSION_TYPE GDK_BACKEND >/dev/null 2>&1 || true
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
sleep 1
python3 tests/computer/wayland.py "$PWD/target/debug/ace-screen-helper-linux"
