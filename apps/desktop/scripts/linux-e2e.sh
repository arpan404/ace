#!/bin/bash
# The desktop app's Electron e2e tests (`bun run desktop:e2e`) on Linux, each session a
# throwaway desktop with its own D-Bus, runtime directory and XDG folders:
#   wayland        headless GNOME Shell (Wayland only, no Xwayland), Electron forced to
#                  `--ozone-platform=wayland` (the default session)
#   wayland-auto   the same desktop, Electron left to pick its platform
#   all            the two in turn
#   kde            KDE Plasma 6 on KWin Wayland, through
#                  native/screen-helper-linux/tests/computer/kde-session.sh (which lists what
#                  KDE needs); not part of `all`
#   hyprland       Hyprland (Omarchy's desktop) on a vkms device, as
#                  apps/daemon/scripts/linux-e2e/hyprland-session.sh sets it up (it lists what
#                  it needs); Electron runs Wayland-native. Not part of `all`
# The browser scenarios need ace's pinned Chrome for the daemon's headless engine; it is
# fetched into ACE_E2E_CHROME_HOME. Where the kernel restricts unprivileged user namespaces
# (Ubuntu 23.10+), Electron's and Chrome's sandboxes need AppArmor profiles: one is loaded for
# each for the run and removed afterwards (sudo).
#
# Usage, from anywhere inside a Linux checkout after `bun install`:
#   apps/desktop/scripts/linux-e2e.sh [wayland|wayland-auto|all|kde|hyprland] [vitest filters]
# Needs: dbus, gnome-shell, pipewire, wireplumber, xdg-desktop-portal-gnome. Environment:
# ACE_E2E_APPARMOR_PROFILE (profile name prefix, default ace-desktop-e2e),
# ACE_E2E_CHROME_HOME (default ~/.cache/ace-desktop-e2e), ACE_E2E_LOGS (session logs, default a
# new temp directory).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
self="$root/apps/desktop/scripts/linux-e2e.sh"

wait_for() { # <seconds> <command...>
  local tries=$(($1 * 10))
  shift
  for _ in $(seq "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  echo "Timed out waiting for: $*" >&2
  return 1
}

run_suite() {
  cd "$root/apps/desktop"
  ACE_E2E_ELECTRON=1 node "$root/node_modules/vitest/vitest.mjs" run \
    --config vitest.e2e.config.ts "$@" 2>&1
}

# Inside dbus-run-session: GNOME Shell, then the suite.
inner_wayland() {
  unset DISPLAY
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME
  pipewire >"$logs/pipewire.log" 2>&1 &
  sleep 1
  wireplumber >"$logs/wireplumber.log" 2>&1 &
  local socket
  socket="ace-desktop-e2e-$$"
  gnome-shell --headless --wayland --no-x11 --wayland-display="$socket" \
    --virtual-monitor 3200x2000 >"$logs/gnome-shell.log" 2>&1 &
  wait_for 30 test -S "$XDG_RUNTIME_DIR/$socket"
  export WAYLAND_DISPLAY=$socket
  dbus-update-activation-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE \
    XDG_CURRENT_DESKTOP XDG_DATA_DIRS >/dev/null 2>&1 || true
  sleep 3
  local status=0
  run_suite "$@" || status=$?
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  return $status
}

# Inside kde-session.sh.
inner_kde() {
  run_suite "$@"
}

# shellcheck source=../../daemon/scripts/linux-e2e/hyprland-session.sh
. "$root/apps/daemon/scripts/linux-e2e/hyprland-session.sh"

# Inside dbus-run-session: Hyprland with its bar, notifications and idle daemon, then the suite.
inner_hyprland() {
  hyprland_session 3200x2000
  local status=0
  run_suite "$@" || status=$?
  hyprctl clients >"$logs/clients.txt" 2>&1 || true
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  return $status
}

case "${1:-}" in
  __hyprland)
    shift
    inner_hyprland "$@"
    exit $?
    ;;
  __kde)
    shift
    inner_kde "$@"
    exit $?
    ;;
  __wayland)
    shift
    inner_wayland "$@"
    exit $?
    ;;
esac

mode=wayland
case "${1:-}" in
  wayland | wayland-auto | all | kde | hyprland)
    mode=$1
    shift
    ;;
esac
prefix=${ACE_E2E_APPARMOR_PROFILE:-ace-desktop-e2e}
# Not the daemon runner's copy: two loaded profiles attached to one path apply to neither, so
# concurrent runs of both would break each other's sandbox.
chrome_home=${ACE_E2E_CHROME_HOME:-$HOME/.cache/ace-desktop-e2e}
export XDG_DATA_DIRS=${XDG_DATA_DIRS:-/usr/local/share:/usr/share}
if ! [[ $prefix =~ ^[a-z0-9-]+$ ]]; then
  echo "Profile names are lowercase words and dashes" >&2
  exit 2
fi

# The electron package fetches its binary the first time it is required.
electron=$(cd "$root/apps/desktop" && readlink -f "$(node -p 'require("electron")')")
echo "Fetching ace's pinned Chrome into $chrome_home"
ACE_CHROMIUM_PATH=$(cd "$root" && node apps/daemon/scripts/linux-e2e/chrome.ts install "$chrome_home" | tail -n 1)
export ACE_CHROMIUM_PATH

scratch=$(mktemp -d /tmp/ace-desktop-e2e.XXXXXX)
profiles=()
cleanup() {
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  local path
  for path in "${profiles[@]}"; do
    sudo apparmor_parser -R "$path" >/dev/null 2>&1 || true
    sudo rm -f "$path"
  done
  rm -rf "$scratch"
}
trap cleanup EXIT
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  for pair in "electron:$electron" "chrome:$ACE_CHROMIUM_PATH"; do
    name="$prefix-${pair%%:*}"
    path="/etc/apparmor.d/$name"
    echo "Installing AppArmor profile $name for ${pair#*:}"
    (cd "$root" && node apps/daemon/scripts/linux-e2e/chrome.ts apparmor "${pair#*:}" "$name") |
      sudo tee "$path" >/dev/null
    profiles+=("$path")
    sudo apparmor_parser -r "$path"
  done
fi

session() { # <mode> [vitest filters]
  local which=$1
  shift
  local runtime state status=0
  runtime=$(mktemp -d "$scratch/rt.XXXXXX")
  state=$(mktemp -d "$scratch/state.XXXXXX")
  chmod 700 "$runtime"
  logs=${ACE_E2E_LOGS:-$scratch/logs}/$which
  mkdir -p "$logs"
  export logs
  echo "=== $which (logs: $logs)"
  local xdg=(XDG_RUNTIME_DIR="$runtime" XDG_CONFIG_HOME="$state/config"
    XDG_STATE_HOME="$state/state" XDG_CACHE_HOME="$state/cache" XDG_DATA_HOME="$state/data")
  case $which in
    wayland | hyprland)
      # Every Electron the tests start runs Wayland-native, never through Xwayland.
      printf '#!/bin/sh\nexec %q --ozone-platform=wayland "$@"\n' "$electron" >"$scratch/electron"
      chmod +x "$scratch/electron"
      [ "$which" = hyprland ] && hyprland_device
      env "${xdg[@]}" ACE_E2E_ELECTRON_BINARY="$scratch/electron" \
        dbus-run-session -- "$self" "__$which" "$@" 2>>"$logs/session.log" || status=$?
      ;;
    wayland-auto)
      env "${xdg[@]}" dbus-run-session -- "$self" __wayland "$@" \
        2>>"$logs/session.log" || status=$?
      ;;
    kde)
      # kde-session.sh makes its own runtime and XDG folders; the screen is sized for scale 2.
      (cd "$root/apps/desktop" && ACE_KDE_SIZE=3200x2000 ACE_KDE_LOGS="$logs" ACE_E2E_ELECTRON=1 \
        "$root/native/screen-helper-linux/tests/computer/kde-session.sh" \
        "$self" __kde "$@") || status=$?
      ;;
  esac
  # The document portal mounts itself in the runtime directory.
  fusermount3 -u "$runtime/doc" 2>/dev/null || fusermount -u "$runtime/doc" 2>/dev/null || true
  rm -rf "$runtime" "$state"
  return $status
}

if [ "$mode" = all ]; then
  failed=()
  for which in wayland wayland-auto; do session "$which" "$@" || failed+=("$which"); done
  if [ ${#failed[@]} -gt 0 ]; then
    echo "Failed sessions: ${failed[*]}" >&2
    exit 1
  fi
  echo "All sessions passed"
else
  session "$mode" "$@"
fi
