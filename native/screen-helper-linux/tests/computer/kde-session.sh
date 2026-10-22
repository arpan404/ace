#!/bin/bash
# Runs a command inside a throwaway headless KDE Plasma 6 session with its own D-Bus, runtime and
# XDG dirs, PipeWire, WirePlumber, the AT-SPI bus and Plasma's shell, kded and KRunner. No display
# manager and no login: KWin renders to a virtual output (Wayland) or manages an Xvfb (X11).
#
# Usage: tests/computer/kde-session.sh <wayland|x11> <command...>
# Needs: kwin-wayland (or kwin-x11 and Xvfb), plasma-workspace, xdg-desktop-portal-kde, pipewire,
# wireplumber, at-spi2-core. Environment: ACE_KDE_DISPLAY (X display number for x11, default 27),
# ACE_KDE_SIZE (output size, default 1280x800), ACE_KDE_LOGS (logs, default a new temp dir),
# ACE_KDE_PLASMA=0 leaves out plasmashell, kded6 and krunner.
#
# KWin casts the screen (the ScreenCast portal) only when it composites with OpenGL, and its
# virtual output does that only with a DRM render node. A machine without a GPU gets one from
# the vgem module: when no render node is usable the script loads vgem with sudo and gives the
# current user access to its nodes (ACLs, gone at reboot).
set -euo pipefail
kind=${1:-}
case $kind in wayland | x11) shift ;; *)
  echo "Usage: $0 <wayland|x11> <command...>" >&2
  exit 2
  ;;
esac

if [ -z "${ACE_KDE_SESSION_INNER:-}" ]; then
  runtime=$(mktemp -d /tmp/ace-kde-rt.XXXXXX)
  chmod 700 "$runtime"
  state=$(mktemp -d /tmp/ace-kde-state.XXXXXX)
  # Also when the session is stopped (a timeout, Ctrl-C): nothing is left in /tmp.
  remove() {
    # The document portal leaves a FUSE mount in the runtime dir.
    fusermount3 -u "$runtime/doc" 2>/dev/null || fusermount -u "$runtime/doc" 2>/dev/null || true
    rm -rf "$runtime" "$state" 2>/dev/null || true
  }
  trap remove EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  status=0
  ACE_KDE_SESSION_INNER=1 XDG_RUNTIME_DIR="$runtime" XDG_CONFIG_HOME="$state/config" \
    XDG_DATA_HOME="$state/data" XDG_STATE_HOME="$state/state" XDG_CACHE_HOME="$state/cache" \
    dbus-run-session -- "$0" "$kind" "$@" || status=$?
  exit $status
fi

logs=${ACE_KDE_LOGS:-$(mktemp -d /tmp/ace-kde-logs.XXXXXX)}
mkdir -p "$logs"
size=${ACE_KDE_SIZE:-1280x800}
width=${size%x*}
height=${size#*x}

wait_for() { # <seconds> <command...>
  local tries=$(($1 * 10))
  shift
  for _ in $(seq "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  echo "Timed out waiting for: $*" >&2
  return 1
}

usable() { [ -r "$1" ] && [ -w "$1" ]; }

# The primary node that shares a render node's device (KWin opens both).
card_of() {
  local device card
  device=$(readlink -f "/sys/class/drm/$(basename "$1")/device")
  for card in /dev/dri/card*; do
    [ "$(readlink -f "/sys/class/drm/$(basename "$card")/device")" = "$device" ] && echo "$card" && return
  done
}

render_node_ready() {
  local node card
  for node in /dev/dri/renderD*; do
    [ -e "$node" ] || continue
    card=$(card_of "$node")
    usable "$node" && { [ -z "$card" ] || usable "$card"; } && return 0
  done
  return 1
}

opengl_for_kwin() {
  render_node_ready && return 0
  echo "No usable DRM render node: loading vgem (sudo) so KWin composites with OpenGL" >&2
  sudo -n modprobe vgem || return 0
  local node card
  for node in /dev/dri/renderD*; do
    case $(readlink -f "/sys/class/drm/$(basename "$node")/device") in *vgem*) ;; *) continue ;; esac
    card=$(card_of "$node")
    sudo -n setfacl -m "u:$(id -un):rw" "$node" ${card:+"$card"} || true
  done
  render_node_ready || echo "Still no render node: screen casting will fail on this machine" >&2
}

export XDG_SESSION_TYPE=$kind XDG_CURRENT_DESKTOP=KDE XDG_SESSION_DESKTOP=KDE \
  KDE_SESSION_VERSION=6 KDE_FULL_SESSION=true XDG_MENU_PREFIX=plasma-
unset DISPLAY WAYLAND_DISPLAY
# Services the bus starts (the portals first) must see the desktop before anything asks for them.
dbus-update-activation-environment XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP \
  KDE_SESSION_VERSION KDE_FULL_SESSION XDG_MENU_PREFIX XDG_RUNTIME_DIR XDG_CONFIG_HOME \
  XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME >/dev/null 2>&1
# KWin finds a client's allowed private protocols (the portal's screencast) through KService.
kbuildsycoca6 --noincremental >"$logs/sycoca.log" 2>&1 || true

children=()
cleanup() {
  [ ${#children[@]} -gt 0 ] && kill "${children[@]}" 2>/dev/null
  pkill -P $$ 2>/dev/null || true
}
trap cleanup EXIT
pipewire >"$logs/pipewire.log" 2>&1 &
children+=($!)
sleep 0.5
wireplumber >"$logs/wireplumber.log" 2>&1 &
children+=($!)

if [ "$kind" = wayland ]; then
  opengl_for_kwin
  socket="ace-kde-$$"
  kwin_wayland --virtual --width "$width" --height "$height" --socket "$socket" \
    --no-lockscreen --no-global-shortcuts >"$logs/kwin.log" 2>&1 &
  children+=($!)
  wait_for 30 test -S "$XDG_RUNTIME_DIR/$socket"
  export WAYLAND_DISPLAY=$socket QT_QPA_PLATFORM=wayland GDK_BACKEND=wayland
else
  display=${ACE_KDE_DISPLAY:-27}
  if [ -e "/tmp/.X11-unix/X$display" ]; then
    echo "Display :$display is taken; set ACE_KDE_DISPLAY" >&2
    exit 1
  fi
  Xvfb ":$display" -screen 0 "${width}x${height}x24" -nolisten tcp >"$logs/xvfb.log" 2>&1 &
  children+=($!)
  export DISPLAY=":$display" QT_QPA_PLATFORM=xcb GDK_BACKEND=x11
  wait_for 10 xdpyinfo
  kwin_x11 >"$logs/kwin.log" 2>&1 &
  children+=($!)
  wait_for 15 sh -c 'xprop -root _NET_SUPPORTING_WM_CHECK | grep -q "window id"'
fi
dbus-update-activation-environment DISPLAY WAYLAND_DISPLAY QT_QPA_PLATFORM GDK_BACKEND \
  >/dev/null 2>&1 || true
/usr/libexec/at-spi-bus-launcher --launch-immediately >"$logs/at-spi.log" 2>&1 &
children+=($!)
if [ "${ACE_KDE_PLASMA:-1}" != 0 ]; then
  plasmashell --no-respawn >"$logs/plasmashell.log" 2>&1 &
  children+=($!)
  kded6 >"$logs/kded.log" 2>&1 &
  children+=($!)
  krunner --daemon >"$logs/krunner.log" 2>&1 &
  children+=($!)
fi
sleep 2
status=0
"$@" || status=$?
exit $status
