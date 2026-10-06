#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
node "$root/tools/web-perf/device/session.ts"
perf_dir=$(mktemp -d /tmp/ace-device-perf.XXXXXX)
udid=
cleanup() {
  if [ "${ACE_PERF_KEEP:-0}" = 1 ]; then echo "Sandbox retained: $perf_dir $udid" >&2; return; fi
  if [ -n "$udid" ]; then
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  fi
  rm -rf "$perf_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
runtime=${ACE_PERF_RUNTIME:-$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; print(next(r["identifier"] for r in json.load(sys.stdin)["runtimes"] if r["isAvailable"] and "iOS" in r["identifier"]))')}
device_name="ace-perf-${perf_dir##*.}"
udid=$(xcrun simctl create "$device_name" com.apple.CoreSimulator.SimDeviceType.iPhone-16 "$runtime")
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b >&2
mkdir -p "$perf_dir/Probe.app"
xcrun swiftc -parse-as-library -O -target "$(uname -m)-apple-ios18.0-simulator" -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" "$root/tools/web-perf/device/Probe.swift" -o "$perf_dir/Probe.app/Probe"
cat > "$perf_dir/Probe.app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.ace.perf-probe</string><key>CFBundleExecutable</key><string>Probe</string><key>CFBundleName</key><string>ace perf</string><key>CFBundlePackageType</key><string>APPL</string><key>UILaunchScreen</key><dict/><key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array></dict></plist>
PLIST
xcrun simctl install "$udid" "$perf_dir/Probe.app"
xcrun simctl launch "$udid" dev.ace.perf-probe >&2
open -g -a Simulator --args -CurrentDeviceUDID "$udid"
helper=${ACE_PERF_HELPER:-$root/native/screen-helper/build/ace-screen-helper}
if [ -z "${ACE_PERF_HELPER:-}" ]; then sh "$root/native/screen-helper/build.sh" >&2; fi
fps=${ACE_PERF_FPS:-60}
if [ "${ACE_PERF_BASELINE:-0}" = 1 ]; then fps=${ACE_PERF_FPS:-10}; fi
ACE_HOME="$perf_dir" ACE_PERF_DEVICE_NAME="$device_name" ACE_PERF_UDID="$udid" ACE_PERF_FPS="$fps" ACE_SCREEN_HELPER="$helper" ACE_SCREEN_HELPER_INHERIT_RESPONSIBILITY=1 node "$root/tools/web-perf/device/${ACE_PERF_DRIVER:-measure}.ts"
