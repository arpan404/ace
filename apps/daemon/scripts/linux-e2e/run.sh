#!/bin/bash
# Linux end to end: the real daemon, ace MCP server, ace's pinned Chrome (sandboxed) and the
# Linux screen helper, driven by scripted agents (no provider CLI, no model, no quota). Each
# session is a throwaway desktop with its own D-Bus, runtime directory and app state.
#
# Usage, from anywhere inside a Linux checkout after `bun install`:
#   apps/daemon/scripts/linux-e2e/run.sh [x11|wayland|headless|all] [extra vitest args]
#   apps/daemon/scripts/linux-e2e/run.sh [kde-wayland|kde-x11|kde] [extra vitest args]
# Needs: cargo, Xvfb, openbox, at-spi2-core, dbus, gnome-calculator, gnome-text-editor, xterm,
# xdpyinfo, ffmpeg (decodes the live view); for wayland gnome-shell, pipewire, wireplumber, xdg-desktop-portal-gnome; sudo for
# the AppArmor profile when the kernel restricts user namespaces (it is removed afterwards).
# The KDE sessions (native/screen-helper-linux/tests/computer/kde-session.sh) need kwin-wayland,
# kwin-x11, plasma-workspace, xdg-desktop-portal-kde, kcalc, kwrite, konsole, gir1.2-atspi-2.0,
# and on a machine without a GPU sudo to load vgem (KWin casts the screen only with OpenGL).
# Environment: ACE_E2E_DISPLAY (X display number, default 51), ACE_E2E_APPARMOR_PROFILE
# (default ace-chromium-e2e), ACE_E2E_CHROME_HOME (where the pinned Chrome is kept, default
# ~/.cache/ace-linux-e2e), ACE_E2E_LOGS (session logs, default a new temp directory).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
self="$root/apps/daemon/scripts/linux-e2e/run.sh"
# ACE_E2E_SUITES (space separated test files) runs only those.
read -r -a suites <<<"${ACE_E2E_SUITES:-apps/daemon/src/linux-desktop.e2e.process.test.ts apps/daemon/src/linux-live-view.e2e.process.test.ts}"

# One file at a time, in this order: they share the desktop, and a live view brings its window
# to the front, which the desktop suite expects in the background.
run_suite() {
  cd "$root"
  local status=0 suite
  for suite in "${suites[@]}"; do
    ACE_LINUX_DESKTOP_E2E="$1" bun run test --project process "$suite" "${@:2}" || status=1
  done
  return $status
}

wait_for() { # <seconds> <command...>
  local tries=$(($1 * 10))
  shift
  for _ in $(seq "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  echo "Timed out waiting for: $*" >&2
  return 1
}

# Inside dbus-run-session: one desktop, its apps, then the suite.
inner_x11() {
  local display=$1
  shift
  Xvfb ":$display" -screen 0 1600x1000x24 -nolisten tcp >"$logs/xvfb.log" 2>&1 &
  export DISPLAY=":$display" XDG_SESSION_TYPE=x11
  wait_for 10 xdpyinfo
  dbus-update-activation-environment DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE XDG_DATA_DIRS \
    >/dev/null 2>&1 || true
  openbox >"$logs/openbox.log" 2>&1 &
  /usr/libexec/at-spi-bus-launcher --launch-immediately >"$logs/at-spi.log" 2>&1 &
  sleep 0.5
  gnome-calculator >"$logs/calculator.log" 2>&1 &
  gnome-text-editor --standalone >"$logs/text-editor.log" 2>&1 &
  sleep 3
  # A terminal takes focus, so the apps sit in the background as an agent usually finds them.
  xterm >"$logs/xterm.log" 2>&1 &
  sleep 1
  local status=0
  run_suite x11 "$@" 2>&1 || status=$?
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  return $status
}

inner_wayland() {
  unset DISPLAY
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME GDK_BACKEND=wayland
  pipewire >"$logs/pipewire.log" 2>&1 &
  sleep 1
  wireplumber >"$logs/wireplumber.log" 2>&1 &
  gnome-shell --headless --wayland --no-x11 --wayland-display=ace-e2e \
    --virtual-monitor 1280x800 >"$logs/gnome-shell.log" 2>&1 &
  wait_for 30 test -S "$XDG_RUNTIME_DIR/ace-e2e"
  export WAYLAND_DISPLAY=ace-e2e
  dbus-update-activation-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE \
    XDG_CURRENT_DESKTOP GDK_BACKEND XDG_DATA_DIRS >/dev/null 2>&1 || true
  /usr/libexec/at-spi-bus-launcher --launch-immediately >"$logs/at-spi.log" 2>&1 &
  sleep 4
  gnome-calculator >"$logs/calculator.log" 2>&1 &
  gnome-text-editor --standalone >"$logs/text-editor.log" 2>&1 &
  sleep 3
  local status=0
  run_suite wayland "$@" 2>&1 || status=$?
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  return $status
}

# Inside kde-session.sh (KDE Plasma 6 on KWin, Wayland or X11): KDE's apps, then the suite.
inner_kde() {
  local kind=$1
  shift
  local note="$XDG_DATA_HOME/ace-e2e-note.txt"
  mkdir -p "$XDG_DATA_HOME"
  printf 'hello\n' >"$note"
  kcalc >"$logs/kcalc.log" 2>&1 &
  kwrite "$note" >"$logs/kwrite.log" 2>&1 &
  sleep 3
  # Konsole takes focus, so the apps sit in the background, and an agent must never see it.
  konsole >"$logs/konsole.log" 2>&1 &
  sleep 2
  local status=0
  # The suites pick KDE's apps from XDG_CURRENT_DESKTOP=KDE, which kde-session.sh sets.
  run_suite "$kind" "$@" 2>&1 || status=$?
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  return $status
}

case "${1:-}" in
  __kde)
    shift
    inner_kde "$@"
    exit $?
    ;;
  __x11)
    shift
    inner_x11 "$@"
    exit $?
    ;;
  __wayland)
    shift
    inner_wayland "$@"
    exit $?
    ;;
esac

mode=${1:-all}
[ $# -gt 0 ] && shift
display=${ACE_E2E_DISPLAY:-51}
profile=${ACE_E2E_APPARMOR_PROFILE:-ace-chromium-e2e}
chrome_home=${ACE_E2E_CHROME_HOME:-$HOME/.cache/ace-linux-e2e}
export XDG_DATA_DIRS=${XDG_DATA_DIRS:-/usr/local/share:/usr/share}

echo "Building the screen helper"
(cd "$root/native/screen-helper-linux" && cargo build --release --quiet)
# Staged outside the home directory: tests refuse paths under the real home.
helper_dir=$(mktemp -d /tmp/ace-e2e-helper.XXXXXX)
cp "$root/native/screen-helper-linux/target/release/ace-screen-helper-linux" "$helper_dir/"
export ACE_SCREEN_HELPER="$helper_dir/ace-screen-helper-linux"

echo "Fetching ace's pinned Chrome into $chrome_home"
ACE_CHROMIUM_PATH=$(cd "$root" && node apps/daemon/scripts/linux-e2e/chrome.ts install "$chrome_home" | tail -n 1)
export ACE_CHROMIUM_PATH
profile_path="/etc/apparmor.d/$profile"
cleanup() {
  rm -rf "$helper_dir"
  if [ -f "$profile_path" ] && [ -z "${ACE_E2E_KEEP_PROFILE:-}" ]; then
    sudo apparmor_parser -R "$profile_path" >/dev/null 2>&1 || true
    sudo rm -f "$profile_path"
  fi
}
trap cleanup EXIT
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  echo "Installing AppArmor profile $profile for $ACE_CHROMIUM_PATH"
  (cd "$root" && node apps/daemon/scripts/linux-e2e/chrome.ts apparmor "$ACE_CHROMIUM_PATH" "$profile") |
    sudo tee "$profile_path" >/dev/null
  sudo apparmor_parser -r "$profile_path"
fi

session() { # <mode> [vitest args]: one session with a private runtime dir, state and logs
  local which=$1
  shift
  local runtime state
  runtime=$(mktemp -d /tmp/ace-e2e-rt.XXXXXX)
  state=$(mktemp -d /tmp/ace-e2e-state.XXXXXX)
  logs=${ACE_E2E_LOGS:-$(mktemp -d /tmp/ace-e2e-logs.XXXXXX)}/$which
  mkdir -p "$logs"
  export logs
  chmod 700 "$runtime"
  local status=0
  echo "=== $which (logs: $logs)"
  case $which in
    x11)
      if [ -e "/tmp/.X11-unix/X$display" ]; then
        echo "Display :$display is taken; set ACE_E2E_DISPLAY" >&2
        return 1
      fi
      XDG_RUNTIME_DIR=$runtime XDG_CONFIG_HOME=$state/config XDG_STATE_HOME=$state/state \
        XDG_CACHE_HOME=$state/cache XDG_DATA_HOME=$state/data \
        dbus-run-session -- "$self" __x11 "$display" "$@" 2>>"$logs/session.log" || status=$?
      ;;
    wayland)
      XDG_RUNTIME_DIR=$runtime XDG_CONFIG_HOME=$state/config XDG_STATE_HOME=$state/state \
        XDG_CACHE_HOME=$state/cache XDG_DATA_HOME=$state/data \
        dbus-run-session -- "$self" __wayland "$@" 2>>"$logs/session.log" || status=$?
      ;;
    headless)
      (unset DISPLAY WAYLAND_DISPLAY && XDG_SESSION_TYPE=tty run_suite headless "$@") ||
        status=$?
      ;;
    kde-wayland | kde-x11)
      # kde-session.sh makes its own runtime dir, state dirs and bus.
      ACE_KDE_LOGS=$logs ACE_KDE_DISPLAY=$display "$kde_session" "${which#kde-}" \
        "$self" __kde "${which#kde-}" "$@" 2>>"$logs/session.log" || status=$?
      ;;
    *)
      echo "Unknown session: $which (x11, wayland, headless, kde-wayland, kde-x11, kde or all)" >&2
      status=2
      ;;
  esac
  # The document portal mounts itself in the runtime directory.
  fusermount3 -u "$runtime/doc" 2>/dev/null || fusermount -u "$runtime/doc" 2>/dev/null || true
  rm -rf "$runtime" "$state"
  return $status
}

kde_session="$root/native/screen-helper-linux/tests/computer/kde-session.sh"
if [ "$mode" = all ] || [ "$mode" = kde ]; then
  failed=()
  sessions=(x11 wayland headless)
  [ "$mode" = kde ] && sessions=(kde-wayland kde-x11)
  for which in "${sessions[@]}"; do session "$which" "$@" || failed+=("$which"); done
  if [ ${#failed[@]} -gt 0 ]; then
    echo "Failed sessions: ${failed[*]}" >&2
    exit 1
  fi
  echo "All sessions passed"
else
  session "$mode" "$@"
fi
