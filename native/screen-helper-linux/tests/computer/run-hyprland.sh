#!/bin/bash
# Live check of the person's side of `--computer` on Hyprland (hyprland.py), in a throwaway
# Hyprland session on a virtual display (apps/daemon/scripts/linux-e2e/hyprland-session.sh, which
# lists what it needs: hyprland, xdg-desktop-portal-hyprland, waybar, mako, hypridle, vkms and
# sudo to load it). Needs also: gnome-calculator, swaylock.
# Usage: tests/computer/run-hyprland.sh   (from native/screen-helper-linux)
set -euo pipefail
cd "$(dirname "$0")/../.."
helper_dir=$PWD
root=$(cd ../.. && pwd)
wait_for() { # <seconds> <command...>, as hyprland-session.sh expects
  local tries=$(($1 * 10))
  shift
  for _ in $(seq "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
# shellcheck source=../../../../apps/daemon/scripts/linux-e2e/hyprland-session.sh
. "$root/apps/daemon/scripts/linux-e2e/hyprland-session.sh"
if [ "${1:-}" = __inner ]; then
  export logs=$2
  hyprland_session 1600x1000
  status=0
  python3 tests/computer/hyprland.py "$helper_dir/target/debug/ace-screen-helper-linux" || status=$?
  kill $(jobs -p) 2>/dev/null || true
  exit $status
fi
cargo build --quiet
hyprland_device
runtime=$(mktemp -d); chmod 700 "$runtime"; state=$(mktemp -d); logs=$(mktemp -d)
trap 'rm -rf "$runtime" "$state"' EXIT
XDG_RUNTIME_DIR=$runtime XDG_CONFIG_HOME=$state/config XDG_STATE_HOME=$state/state \
  XDG_CACHE_HOME=$state/cache XDG_DATA_HOME=$state/data \
  dbus-run-session -- "$0" __inner "$logs"
