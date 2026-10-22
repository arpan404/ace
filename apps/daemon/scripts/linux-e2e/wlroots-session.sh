# Sourced by run.sh: the Hyprland (Omarchy) and Sway sessions. Each runs inside run.sh's
# dbus-run-session with a private runtime dir, so its Wayland socket, portals and PipeWire
# are its own. Xwayland stays off: these sessions run native Wayland apps only, and an
# Xwayland server would claim a shared X display number.
#
# Hyprland needs a KMS device: run.sh loads vkms (a virtual display; Mesa renders in
# software) and libseat's noop backend opens it without a seat daemon. Sway uses wlroots'
# headless backend. The screen-sharing chooser is portal-picker.sh (test-only).

# Waits for a compositor's socket and exposes it as ace-<name> for the session's clients.
compositor_socket() { compgen -G "$XDG_RUNTIME_DIR/wayland-[0-9]" >/dev/null; }
wayland_socket() { # <name>
  wait_for 30 compositor_socket
  local socket
  socket=$(compgen -G "$XDG_RUNTIME_DIR/wayland-[0-9]" | head -n 1)
  ln -sf "$socket" "$XDG_RUNTIME_DIR/$1"
  export WAYLAND_DISPLAY=$1
}

# What every wlroots-style session shares once its compositor is up: the session bus learns
# the display, then the AT-SPI bus, the desktop's own bar, notifications and idle daemon (as
# Omarchy starts them; they must never reach an agent), and the test's GTK and Qt apps.
wlroots_desktop() {
  dbus-update-activation-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE \
    XDG_CURRENT_DESKTOP GDK_BACKEND GSK_RENDERER QT_QPA_PLATFORM XDG_DATA_DIRS XDG_CONFIG_HOME \
    HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK ACE_E2E_PICKER_CHOICE >/dev/null 2>&1 || true
  /usr/libexec/at-spi-bus-launcher --launch-immediately >"$logs/at-spi.log" 2>&1 &
  sleep 1
  waybar >"$logs/waybar.log" 2>&1 &
  mako >"$logs/mako.log" 2>&1 &
  hypridle >"$logs/hypridle.log" 2>&1 &
  sleep 2
  gnome-calculator >"$logs/calculator.log" 2>&1 &
  gnome-text-editor --standalone >"$logs/text-editor.log" 2>&1 &
  kcalc >"$logs/kcalc.log" 2>&1 &
  sleep 4
}

wlroots_env() { # <XDG_CURRENT_DESKTOP>
  unset DISPLAY
  export XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=$1 GDK_BACKEND=wayland
  export QT_QPA_PLATFORM=wayland ACE_E2E_PICKER_CHOICE=$XDG_RUNTIME_DIR/ace-e2e-picker
  # GTK 4's Vulkan renderer crashes on software Vulkan (lavapipe) over vkms; real GPUs are fine.
  export GSK_RENDERER=cairo
  pipewire >"$logs/pipewire.log" 2>&1 &
  sleep 1
  wireplumber >"$logs/wireplumber.log" 2>&1 &
}

inner_hyprland() {
  wlroots_env Hyprland
  local config=$XDG_CONFIG_HOME/hypr
  mkdir -p "$config"
  cat >"$config/hyprland.conf" <<EOF
monitor = , 1600x1000@60, 0x0, 1
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
  custom_picker_binary = $root/apps/daemon/scripts/linux-e2e/portal-picker.sh
}
EOF
  printf 'general {\n  lock_cmd = true\n}\n' >"$config/hypridle.conf"
  AQ_DRM_DEVICES=$ACE_E2E_DRM_DEVICE LIBSEAT_BACKEND=noop Hyprland -c "$config/hyprland.conf" >"$logs/hyprland.log" 2>&1 &
  wayland_socket ace-hypr-0
  wait_for 10 test -d "$XDG_RUNTIME_DIR/hypr"
  HYPRLAND_INSTANCE_SIGNATURE=$(ls "$XDG_RUNTIME_DIR/hypr")
  export HYPRLAND_INSTANCE_SIGNATURE
  wlroots_desktop
  local status=0
  run_suite hyprland "$@" 2>&1 || status=$?
  hyprctl clients >"$logs/clients.txt" 2>&1 || true
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  return $status
}

inner_sway() {
  wlroots_env sway
  local config=$XDG_CONFIG_HOME/sway
  mkdir -p "$config" "$XDG_CONFIG_HOME/xdg-desktop-portal-wlr"
  cat >"$config/config" <<EOF
output HEADLESS-1 resolution 1600x1000 position 0 0
xwayland disable
EOF
  cat >"$XDG_CONFIG_HOME/xdg-desktop-portal-wlr/config" <<EOF
[screencast]
chooser_type=dmenu
chooser_cmd=$root/apps/daemon/scripts/linux-e2e/portal-picker.sh wlr
EOF
  WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
    sway -c "$config/config" >"$logs/sway.log" 2>&1 &
  wayland_socket ace-hypr-sway-0
  SWAYSOCK=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock 2>/dev/null | head -n 1)
  export SWAYSOCK
  wlroots_desktop
  local status=0
  run_suite sway "$@" 2>&1 || status=$?
  swaymsg -t get_tree >"$logs/tree.json" 2>&1 || true
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  return $status
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
