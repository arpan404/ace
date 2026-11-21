#!/bin/sh
set -eu
source=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$(dirname "$1")"
xcrun swiftc -O -target "$(uname -m)-apple-macos13.0" \
  "$source/Tray.swift" "$source/TrayStyle.swift" "$source/main.swift" -o "$1"
marks="$source/../../apps/ios/Resources/Assets.xcassets/ProviderMarks"
output="$(dirname "$1")/tray-marks"
mkdir -p "$output"
for mark in "$marks"/provider-*.imageset; do
  name=${mark##*/provider-}
  cp "$mark"/*.svg "$output/${name%.imageset}.svg"
done
