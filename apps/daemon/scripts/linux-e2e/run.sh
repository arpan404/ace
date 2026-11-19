#!/bin/bash
# Linux end to end: the real daemon, ace MCP server, ace's pinned Chrome (sandboxed) and the
# Linux screen helper, driven by scripted agents (no provider CLI, no model, no quota). Each
# session is a throwaway desktop with its own D-Bus, runtime directory and app state.
#
# Usage, from anywhere inside a Linux checkout after `bun install`:
#   apps/daemon/scripts/linux-e2e/run.sh [wayland|kde|hyprland|headless|all] [extra vitest args]
# Needs: cargo, at-spi2-core, dbus, gnome-calculator, gnome-text-editor, xterm (listed as an
# installed terminal agents must not reach), ffmpeg (decodes the live view), gnome-shell,
# pipewire, wireplumber, xdg-desktop-portal-gnome; sudo for the AppArmor profile when the kernel
# restricts user namespaces (it is removed afterwards).
# kde (native/screen-helper-linux/tests/computer/kde-session.sh) needs kwin-wayland,
# plasma-workspace, xdg-desktop-portal-kde, kcalc, kwrite, konsole, gir1.2-atspi-2.0, and on a
# machine without a GPU sudo to load vgem (KWin casts the screen only with OpenGL).
# hyprland (Omarchy's desktop) needs hyprland, xdg-desktop-portal-hyprland, waybar, mako,
# hypridle, kcalc, the vkms kernel module and sudo to load it (hyprland-session.sh). `all` is
# wayland and headless.
# Environment: ACE_E2E_APPARMOR_PROFILE
# (default ace-chromium-e2e), ACE_E2E_CHROME_HOME (where the pinned Chrome is kept, default
# ~/.cache/ace-linux-e2e), ACE_E2E_LOGS (session logs, default a new temp directory).
# ACE_E2E_XDPH_PREFIX (hyprland: an xdg-desktop-portal-hyprland install prefix to use instead
# of the distro's, e.g. a build of the version Arch ships).
set -euo pipefail
# A crashed Vitest worker or helper leaves a core (systemd-coredump: `coredumpctl list`) to
# read instead of only a signal name; distributions default the limit to 0.
ulimit -c unlimited 2>/dev/null || true
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

# Ends the session's apps. An editor holding unsaved text answers SIGTERM with a save prompt
# nobody will click, so whatever is left after a moment is killed.
stop_jobs() {
  local pids
  pids=$(jobs -p)
  [ -z "$pids" ] && return 0
  kill $pids 2>/dev/null || true
  local pid left
  for _ in $(seq 30); do
    left=
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && left=1; done
    [ -z "$left" ] && break
    sleep 0.1
  done
  kill -9 $pids 2>/dev/null || true
  wait 2>/dev/null || true
}

# The live-view fixture (a window that reports the input reaching it), launched as a desktop
# launcher would so the desktop names it dev.ace.LiveViewFixture. Its log is the suite's.
fixture() {
  export ACE_E2E_FIXTURE_LOG="$logs/fixture.jsonl"
  : >"$ACE_E2E_FIXTURE_LOG"
  GIO_LAUNCHED_DESKTOP_FILE="$fixture_data/applications/dev.ace.LiveViewFixture.desktop" \
    python3 "$root/apps/daemon/scripts/linux-e2e/live-view-fixture.py" >"$logs/fixture.log" 2>&1 &
}

# Inside dbus-run-session: GNOME Shell, its apps, then the suite.
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
  stop_jobs
  return $status
}

# Inside kde-session.sh (KDE Plasma 6 on KWin): KDE's apps, then the suite.
inner_kde() {
  local note="$XDG_DATA_HOME/ace-e2e-note.txt"
  mkdir -p "$XDG_DATA_HOME"
  printf 'hello\n' >"$note"
  kcalc >"$logs/kcalc.log" 2>&1 &
  kwrite "$note" >"$logs/kwrite.log" 2>&1 &
  # The fixture is GTK 4, whose Vulkan renderer crashes at start on Mesa's software Vulkan
  # over vgem (in the device-select layer), as on the Hyprland session's vkms.
  export GSK_RENDERER=cairo
  fixture
  sleep 3
  # Konsole takes focus, so the apps sit in the background, and an agent must never see it.
  konsole >"$logs/konsole.log" 2>&1 &
  sleep 2
  local status=0
  # The suites pick KDE's apps from XDG_CURRENT_DESKTOP=KDE, which kde-session.sh sets.
  run_suite wayland "$@" 2>&1 || status=$?
  stop_jobs
  return $status
}

# shellcheck source=hyprland-session.sh
. "$root/apps/daemon/scripts/linux-e2e/hyprland-session.sh"

# Inside dbus-run-session: Hyprland (hyprland-session.sh), the test's GTK and Qt apps, then the
# suite.
inner_hyprland() {
  hyprland_session 1600x1000
  gnome-calculator >"$logs/calculator.log" 2>&1 &
  gnome-text-editor --standalone >"$logs/text-editor.log" 2>&1 &
  kcalc >"$logs/kcalc.log" 2>&1 &
  sleep 4
  local status=0
  run_suite hyprland "$@" 2>&1 || status=$?
  hyprctl clients >"$logs/clients.txt" 2>&1 || true
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
  __hyprland)
    shift
    inner_hyprland "$@"
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
# Runs on one machine share the profile (it is for the one pinned Chrome): each run signs in
# here, and the last one out removes it, so a run never loses its sandbox to another's cleanup.
profile_users="/tmp/$profile.users"
mkdir -p "$profile_users"
touch "$profile_users/$$"
cleanup() {
  rm -rf "$helper_dir"
  rm -f "$profile_users/$$"
  local user
  for user in "$profile_users"/*; do
    [ -e "$user" ] && ! kill -0 "$(basename "$user")" 2>/dev/null && rm -f "$user"
  done
  if [ -f "$profile_path" ] && [ -z "${ACE_E2E_KEEP_PROFILE:-}" ] &&
    [ -z "$(ls -A "$profile_users" 2>/dev/null)" ]; then
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
    wayland | hyprland)
      [ "$which" = hyprland ] && hyprland_device
      XDG_RUNTIME_DIR=$runtime XDG_CONFIG_HOME=$state/config XDG_STATE_HOME=$state/state \
        XDG_CACHE_HOME=$state/cache XDG_DATA_HOME=$state/data \
        XDG_DATA_DIRS=$fixture_data:$XDG_DATA_DIRS \
        dbus-run-session -- "$self" "__$which" "$@" 2>>"$logs/session.log" || status=$?
      ;;
    headless)
      (unset DISPLAY WAYLAND_DISPLAY && XDG_SESSION_TYPE=tty run_suite headless "$@") ||
        status=$?
      ;;
    kde)
      # kde-session.sh makes its own runtime dir, state dirs and bus.
      XDG_DATA_DIRS=$fixture_data:$XDG_DATA_DIRS ACE_KDE_LOGS=$logs "$kde_session" \
        "$self" __kde "$@" 2>>"$logs/session.log" || status=$?
      ;;
    *)
      echo "Unknown session: $which (wayland, kde, hyprland, headless or all)" >&2
      status=2
      ;;
  esac
  # The document portal mounts itself in the runtime directory.
  fusermount3 -u "$runtime/doc" 2>/dev/null || fusermount -u "$runtime/doc" 2>/dev/null || true
  rm -rf "$runtime" "$state"
  return $status
}

kde_session="$root/native/screen-helper-linux/tests/computer/kde-session.sh"
if [ "$mode" = all ]; then
  failed=()
  sessions=(wayland headless)
  for which in "${sessions[@]}"; do session "$which" "$@" || failed+=("$which"); done
  if [ ${#failed[@]} -gt 0 ]; then
    echo "Failed sessions: ${failed[*]}" >&2
    exit 1
  fi
  echo "All sessions passed"
else
  session "$mode" "$@"
fi
