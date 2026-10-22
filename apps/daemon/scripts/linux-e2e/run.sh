#!/bin/bash
# Linux end to end: the real daemon, ace MCP server, ace's pinned Chrome (sandboxed) and the
# Linux screen helper, driven by scripted agents (no provider CLI, no model, no quota). Each
# session is a throwaway desktop with its own D-Bus, runtime directory and app state.
#
# Usage, from anywhere inside a Linux checkout after `bun install`:
#   apps/daemon/scripts/linux-e2e/run.sh [x11|wayland|headless|all] [extra vitest args]
# Needs: cargo, Xvfb, openbox, at-spi2-core, dbus, gnome-calculator, gnome-text-editor, xterm,
# xdpyinfo, ffmpeg (decodes the live view); for wayland gnome-shell, pipewire, wireplumber, xdg-desktop-portal-gnome; sudo for
# the AppArmor profile when the kernel restricts user namespaces (it is removed afterwards).
# Environment: ACE_E2E_DISPLAY (X display number, default 51), ACE_E2E_APPARMOR_PROFILE
# (default ace-chromium-e2e), ACE_E2E_CHROME_HOME (where the pinned Chrome is kept, default
# ~/.cache/ace-linux-e2e), ACE_E2E_LOGS (session logs, default a new temp directory).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
self="$root/apps/daemon/scripts/linux-e2e/run.sh"
# ACE_E2E_SUITES (space separated test files) runs only those.
read -r -a suites <<<"${ACE_E2E_SUITES:-apps/daemon/src/linux-desktop.e2e.process.test.ts apps/daemon/src/linux-live-view.e2e.process.test.ts apps/daemon/src/linux-live-view-control.e2e.process.test.ts}"

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

# The live-view fixture (a window that reports the input reaching it), launched as a desktop
# launcher would so X11 and GNOME both name it dev.ace.LiveViewFixture. Its log is the suite's.
fixture() {
  export ACE_E2E_FIXTURE_LOG="$logs/fixture.jsonl"
  : >"$ACE_E2E_FIXTURE_LOG"
  GIO_LAUNCHED_DESKTOP_FILE="$fixture_data/applications/dev.ace.LiveViewFixture.desktop" \
    python3 "$root/apps/daemon/scripts/linux-e2e/live-view-fixture.py" >"$logs/fixture.log" 2>&1 &
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
  fixture
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
  sleep 2
  # Opened last, the fixture is in front of the others, covering the middle of Calculator.
  fixture
  sleep 3
  # The shell starts in the overview; the person at the machine closes it, as before using apps.
  python3 "$root/native/screen-helper-linux/tests/computer/seed_portal.py" press-escape \
    dev.ace.LiveViewFixture.desktop "Live view fixture" >>"$logs/session.log" 2>&1 || true
  sleep 1
  local status=0
  run_suite wayland "$@" 2>&1 || status=$?
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  return $status
}

case "${1:-}" in
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
  # The fixture's desktop file, where the session's apps and its helper look for desktop files.
  fixture_data=$state/fixture-data
  mkdir -p "$logs" "$fixture_data/applications"
  export fixture_data
  export logs
  chmod 700 "$runtime"
  printf '[Desktop Entry]\nType=Application\nName=Live view fixture\nExec=python3 %s\n' \
    "$root/apps/daemon/scripts/linux-e2e/live-view-fixture.py" \
    >"$fixture_data/applications/dev.ace.LiveViewFixture.desktop"
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
        XDG_DATA_DIRS=$fixture_data:$XDG_DATA_DIRS \
        dbus-run-session -- "$self" __x11 "$display" "$@" 2>>"$logs/session.log" || status=$?
      ;;
    wayland)
      XDG_RUNTIME_DIR=$runtime XDG_CONFIG_HOME=$state/config XDG_STATE_HOME=$state/state \
        XDG_CACHE_HOME=$state/cache XDG_DATA_HOME=$state/data \
        XDG_DATA_DIRS=$fixture_data:$XDG_DATA_DIRS \
        dbus-run-session -- "$self" __wayland "$@" 2>>"$logs/session.log" || status=$?
      ;;
    headless)
      (unset DISPLAY WAYLAND_DISPLAY && XDG_SESSION_TYPE=tty run_suite headless "$@") ||
        status=$?
      ;;
    *)
      echo "Unknown session: $which (x11, wayland, headless or all)" >&2
      status=2
      ;;
  esac
  # The document portal mounts itself in the runtime directory.
  fusermount3 -u "$runtime/doc" 2>/dev/null || fusermount -u "$runtime/doc" 2>/dev/null || true
  rm -rf "$runtime" "$state"
  return $status
}

if [ "$mode" = all ]; then
  failed=()
  for which in x11 wayland headless; do session "$which" "$@" || failed+=("$which"); done
  if [ ${#failed[@]} -gt 0 ]; then
    echo "Failed sessions: ${failed[*]}" >&2
    exit 1
  fi
  echo "All sessions passed"
else
  session "$mode" "$@"
fi
