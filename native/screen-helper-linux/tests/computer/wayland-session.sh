#!/bin/sh
# Runs a command inside a throwaway headless GNOME Shell Wayland session with its own D-Bus,
# runtime dir, PipeWire, WirePlumber and the AT-SPI bus. Portals start on demand.
# Needs: gnome-shell, xdg-desktop-portal(-gnome), pipewire, wireplumber, at-spi2-core.
# Usage: tests/computer/wayland-session.sh <command...>
set -eu
if [ -z "${ACE_WAYLAND_SESSION:-}" ]; then
  runtime=$(mktemp -d)
  chmod 700 "$runtime"
  state=$(mktemp -d)
  status=0
  ACE_WAYLAND_SESSION=1 XDG_RUNTIME_DIR="$runtime" XDG_DATA_HOME="$state/data" \
    XDG_CONFIG_HOME="$state/config" XDG_STATE_HOME="$state/state" XDG_CACHE_HOME="$state/cache" \
    dbus-run-session -- "$0" "$@" || status=$?
  # The document portal leaves a FUSE mount in the runtime dir.
  fusermount3 -u "$runtime/doc" 2>/dev/null || fusermount -u "$runtime/doc" 2>/dev/null || true
  rm -rf "$runtime" "$state" 2>/dev/null || true
  exit $status
fi
unset DISPLAY
export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME GDK_BACKEND=wayland
pipewire >/dev/null 2>&1 &
wireplumber >/dev/null 2>&1 &
gnome-shell --headless --debug-control --wayland --no-x11 --wayland-display=wayland-0 --virtual-monitor 1280x800 >/dev/null 2>&1 &
shell=$!
trap 'kill $shell 2>/dev/null; pkill -P $$ 2>/dev/null || true' EXIT
for _ in $(seq 100); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
export WAYLAND_DISPLAY=wayland-0
dbus-update-activation-environment WAYLAND_DISPLAY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP GDK_BACKEND XDG_RUNTIME_DIR >/dev/null 2>&1 || true
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
sleep 1
"$@"
