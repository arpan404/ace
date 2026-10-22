#!/bin/bash
# The desktop app's Electron e2e tests (`bun run desktop:e2e`) on Linux, on a throwaway Xvfb
# display with openbox. Where the kernel restricts unprivileged user namespaces (Ubuntu
# 23.10+), Electron's sandbox needs an AppArmor profile: one is loaded for this checkout's
# Electron and removed afterwards (sudo).
#
# Usage, from anywhere inside a Linux checkout after `bun install`:
#   apps/desktop/scripts/linux-e2e.sh [vitest filters]   e.g. browser-video
# Needs: Xvfb, openbox. Environment: ACE_E2E_DISPLAY (X display number, default 52),
# ACE_E2E_APPARMOR_PROFILE (default ace-electron-e2e), ACE_E2E_DESKTOP (openbox, the default;
# kde-wayland or kde-x11 run the app on KDE Plasma 6 through
# native/screen-helper-linux/tests/computer/kde-session.sh, which lists what KDE needs).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
display=${ACE_E2E_DISPLAY:-52}
desktop=${ACE_E2E_DESKTOP:-openbox}
case $desktop in openbox | kde-wayland | kde-x11) ;; *)
  echo "ACE_E2E_DESKTOP is openbox, kde-wayland or kde-x11" >&2
  exit 2
  ;;
esac
profile=${ACE_E2E_APPARMOR_PROFILE:-ace-electron-e2e}
profile_path="/etc/apparmor.d/$profile"
if [ -e "/tmp/.X11-unix/X$display" ]; then
  echo "Display :$display is taken; set ACE_E2E_DISPLAY" >&2
  exit 1
fi
if ! [[ $profile =~ ^[a-z0-9-]+$ ]]; then
  echo "Profile names are lowercase words and dashes" >&2
  exit 2
fi

# The electron package fetches its binary the first time it is required.
electron=$(cd "$root/apps/desktop" && readlink -f "$(node -p 'require("electron")')")
loaded=""
cleanup() {
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  if [ -n "$loaded" ]; then
    sudo apparmor_parser -R "$profile_path" >/dev/null 2>&1 || true
    sudo rm -f "$profile_path"
  fi
}
trap cleanup EXIT
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  echo "Installing AppArmor profile $profile for $electron"
  (cd "$root" && node apps/daemon/scripts/linux-e2e/chrome.ts apparmor "$electron" "$profile") |
    sudo tee "$profile_path" >/dev/null
  loaded=1
  sudo apparmor_parser -r "$profile_path"
fi

if [ "$desktop" != openbox ]; then
  cd "$root/apps/desktop"
  ACE_KDE_DISPLAY=$display ACE_E2E_ELECTRON=1 "$root/native/screen-helper-linux/tests/computer/kde-session.sh" \
    "${desktop#kde-}" node "$root/node_modules/vitest/vitest.mjs" run --config vitest.e2e.config.ts "$@"
  exit $?
fi
Xvfb ":$display" -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
for _ in $(seq 100); do [ -e "/tmp/.X11-unix/X$display" ] && break; sleep 0.1; done
DISPLAY=":$display" openbox >/dev/null 2>&1 &
sleep 0.5
cd "$root/apps/desktop"
DISPLAY=":$display" XDG_SESSION_TYPE=x11 ACE_E2E_ELECTRON=1 \
  node "$root/node_modules/vitest/vitest.mjs" run --config vitest.e2e.config.ts "$@"
