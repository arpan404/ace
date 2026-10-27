# Sourced by the Linux e2e runners (apps/daemon/scripts/linux-e2e/run.sh and
# apps/desktop/scripts/linux-e2e.sh): a Hyprland session (Omarchy's desktop). It runs inside
# the runner's dbus-run-session with a private runtime dir, so its Wayland socket, portals and
# PipeWire are its own. Xwayland stays off: the session runs native Wayland apps only, and an
# Xwayland server would claim a shared X display number.
#
# Hyprland needs a KMS device: hyprland_device loads vkms (a virtual display; Mesa renders in
# software) and libseat's noop backend opens it without a seat daemon. The screen-sharing
# chooser is portal-picker.sh (test-only).
#
# The sourcing script defines wait_for <seconds> <command...> and exports $logs and $root.
session_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Waits for a compositor's socket and exposes it as <name> for the session's clients.
compositor_socket() { compgen -G "$XDG_RUNTIME_DIR/wayland-[0-9]" >/dev/null; }
wayland_socket() { # <name>
  wait_for 30 compositor_socket
  local socket
  socket=$(compgen -G "$XDG_RUNTIME_DIR/wayland-[0-9]" | head -n 1)
  ln -sf "$socket" "$XDG_RUNTIME_DIR/$1"
  export WAYLAND_DISPLAY=$1
}

hyprland_env() {
  unset DISPLAY
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=Hyprland GDK_BACKEND=wayland
  export QT_QPA_PLATFORM=wayland ACE_E2E_PICKER_CHOICE=$XDG_RUNTIME_DIR/ace-e2e-picker
  # GTK 4's Vulkan renderer crashes on software Vulkan (lavapipe) over vkms; real GPUs are fine.
  export GSK_RENDERER=cairo
  pipewire >"$logs/pipewire.log" 2>&1 &
  sleep 1
  wireplumber >"$logs/wireplumber.log" 2>&1 &
}

# Once the compositor is up: the session bus learns the display, then the AT-SPI bus, the
# desktop's own bar, notifications and idle daemon (as Omarchy starts them; they must never
# reach an agent or cover the app under test).
hyprland_shell() {
  dbus-update-activation-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE \
    XDG_CURRENT_DESKTOP GDK_BACKEND GSK_RENDERER QT_QPA_PLATFORM XDG_DATA_DIRS XDG_CONFIG_HOME XDG_DATA_HOME \
    HYPRLAND_INSTANCE_SIGNATURE ACE_E2E_PICKER_CHOICE >/dev/null 2>&1 || true
  /usr/libexec/at-spi-bus-launcher --launch-immediately >"$logs/at-spi.log" 2>&1 &
  sleep 1
  waybar >"$logs/waybar.log" 2>&1 &
  mako >"$logs/mako.log" 2>&1 &
  hypridle >"$logs/hypridle.log" 2>&1 &
  sleep 2
}

# ACE_E2E_XDPH_PREFIX=<install prefix>: use that xdg-desktop-portal-hyprland build instead of
# the distro's (Omarchy runs Arch's newer one). It starts before any client asks the portal,
# and the portal frontend reads that build's list of interfaces.
hyprland_portal() { # <prefix>
  local portals=$XDG_RUNTIME_DIR/portals
  mkdir -p "$portals"
  cp /usr/share/xdg-desktop-portal/portals/*.portal "$portals/"
  cp "$1/share/xdg-desktop-portal/portals/hyprland.portal" "$portals/"
  export XDG_DESKTOP_PORTAL_DIR=$portals
  dbus-update-activation-environment XDG_DESKTOP_PORTAL_DIR >/dev/null 2>&1 || true
  "$1/libexec/xdg-desktop-portal-hyprland" --verbose >"$logs/xdph.log" 2>&1 &
  sleep 1
  echo "xdg-desktop-portal-hyprland from $1"
}

# Starts Hyprland on the vkms device (see hyprland_device) with one <width>x<height> monitor
# at scale 1, then the desktop's shell.
hyprland_session() { # <size>
  hyprland_env
  local config=$XDG_CONFIG_HOME/hypr
  mkdir -p "$config"
  cat >"$config/hyprland.conf" <<EOF
monitor = , $1@60, 0x0, 1
xwayland {
  enabled = false
}
misc {
  disable_hyprland_logo = true
  disable_splash_rendering = true
  force_default_wallpaper = 0
}
ecosystem {
  no_update_news = true
  no_donation_nag = true
}
animations {
  enabled = false
}
EOF
  cat >"$config/xdph.conf" <<EOF
screencopy {
  custom_picker_binary = $session_dir/portal-picker.sh
}
EOF
  printf 'general {\n  lock_cmd = true\n}\n' >"$config/hypridle.conf"
  AQ_DRM_DEVICES=$ACE_E2E_DRM_DEVICE LIBSEAT_BACKEND=noop Hyprland -c "$config/hyprland.conf" >"$logs/hyprland.log" 2>&1 &
  wayland_socket ace-hypr-0
  wait_for 10 test -d "$XDG_RUNTIME_DIR/hypr"
  HYPRLAND_INSTANCE_SIGNATURE=$(ls "$XDG_RUNTIME_DIR/hypr")
  export HYPRLAND_INSTANCE_SIGNATURE
  [ -z "${ACE_E2E_XDPH_PREFIX:-}" ] || hyprland_portal "$ACE_E2E_XDPH_PREFIX"
  hyprland_shell
}

# Outside the session: a KMS device Hyprland may open (vkms, made once, opened to this user).
hyprland_device() {
  [ -e /sys/module/vkms ] || sudo modprobe vkms
  sudo udevadm settle
  local card
  for card in /sys/class/drm/card[0-9]*; do
    [[ $card != *-* && $(readlink -f "$card") == */vkms/drm/* ]] || continue
    # udev resets the device's permissions whenever another module adds a DRM device.
    sudo setfacl -m "u:$(id -un):rw" "/dev/dri/${card##*/}"
    export ACE_E2E_DRM_DEVICE=/dev/dri/${card##*/}
  done
  [ -n "${ACE_E2E_DRM_DEVICE:-}" ] || {
    echo "No vkms device for Hyprland" >&2
    return 1
  }
  echo "Hyprland draws on $ACE_E2E_DRM_DEVICE (vkms)"
}
