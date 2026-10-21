#!/bin/bash
# Android on Linux end to end (apps/daemon/src/linux-android.e2e.process.test.ts): the real
# daemon drives a booted Android device through adb and scrcpy. No provider CLI or model runs.
#
# Usage, from anywhere inside a Linux checkout after `bun install`:
#   apps/daemon/scripts/linux-e2e/android.sh [extra vitest args]
#
# With ACE_ANDROID_E2E_SDK set to an Android SDK whose emulator is already booted as
# emulator-5554, the suite runs against it (Linux x64: the real emulator).
#
# Without it, the run uses a stand-in, for Linux arm64 where Google publishes neither the
# Android Emulator nor Platform Tools: Android in a container (redroid, which needs the
# binder_linux module and sudo for containerd), its adbd published on 127.0.0.1:5555 so adb
# names it emulator-5554 as it does an emulator, booted with the AVD name ace reads from an
# emulator, and an SDK folder holding the distribution's adb and an `emulator` that only lists
# that AVD. It stands in for a booted emulator only; booting one is not tested this way.
# Needs: ffmpeg, adb (the distribution's), and for the stand-in nerdctl or docker, containerd.
# Environment: ACE_E2E_REDROID_IMAGE (default redroid/redroid:14.0.0_64only-latest),
# ACE_E2E_REDROID_NAME (container name, default ace-android-e2e), ACE_E2E_ARTIFACTS.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
suite=apps/daemon/src/linux-android.e2e.process.test.ts

run_suite() {
  cd "$root"
  ACE_ANDROID_E2E_SDK="$1" bun run test --project process "$suite" "${@:2}"
}

if [ -n "${ACE_ANDROID_E2E_SDK:-}" ]; then
  run_suite "$ACE_ANDROID_E2E_SDK" "$@"
  exit $?
fi

image=${ACE_E2E_REDROID_IMAGE:-redroid/redroid:14.0.0_64only-latest}
name=${ACE_E2E_REDROID_NAME:-ace-android-e2e}
avd=ace_e2e_android
containers=$(command -v nerdctl || command -v docker)
adb=$(command -v adb) || {
  echo "adb not found: install your distribution's adb package" >&2
  exit 1
}
if ss -ltn 2>/dev/null | grep -q '127.0.0.1:5555 '; then
  echo "127.0.0.1:5555 is taken; the stand-in needs it to be named emulator-5554" >&2
  exit 1
fi

sdk=$(mktemp -d /tmp/ace-android-sdk.XXXXXX)
mkdir -p "$sdk/platform-tools" "$sdk/emulator"
ln -s "$adb" "$sdk/platform-tools/adb"
# Lists the stand-in's AVD; anything else (booting one) is not something it can do.
cat >"$sdk/emulator/emulator" <<EOF
#!/bin/sh
[ "\$1" = "-list-avds" ] && { echo $avd; exit 0; }
echo "The Android stand-in can't boot emulators" >&2
exit 1
EOF
chmod +x "$sdk/emulator/emulator"

started_containerd=
cleanup() {
  sudo "$containers" rm -f "$name" >/dev/null 2>&1 || true
  "$adb" disconnect 127.0.0.1:5555 >/dev/null 2>&1 || true
  [ -n "$started_containerd" ] && sudo systemctl stop containerd
  rm -rf "$sdk"
}
trap cleanup EXIT

sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
if ! systemctl is-active --quiet containerd; then
  sudo systemctl start containerd
  started_containerd=1
fi
sudo "$containers" rm -f "$name" >/dev/null 2>&1 || true
echo "Starting $image as $name"
sudo "$containers" run -d --privileged --name "$name" -p 127.0.0.1:5555:5555 "$image" \
  androidboot.redroid_width=720 androidboot.redroid_height=1280 androidboot.redroid_dpi=320 \
  "androidboot.qemu.avd_name=$avd" >/dev/null
for _ in $(seq 120); do
  (exec 3<>/dev/tcp/127.0.0.1/5555) 2>/dev/null && break
  sleep 1
done
# Announced to the adb server as an emulator announces itself (`host:emulator:<adb port>`).
"$adb" start-server >/dev/null
exec 3<>/dev/tcp/127.0.0.1/5037
printf '0012host:emulator:5555' >&3
exec 3>&-
for _ in $(seq 120); do
  [ "$("$adb" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 1
done
[ "$("$adb" -s emulator-5554 shell getprop ro.boot.qemu.avd_name | tr -d '\r')" = "$avd" ] || {
  echo "The stand-in did not come up as emulator-5554 ($avd)" >&2
  exit 1
}
run_suite "$sdk" "$@"
