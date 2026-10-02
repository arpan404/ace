#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then
  echo 'screen-helper: skipped (requires macOS)'
  exit 0
fi
cd "$(dirname "$0")"
mkdir -p build
swiftc -swift-version 5 -O -parse-as-library -target "$(uname -m)-apple-macosx13.0" \
  -framework AppKit -framework ScreenCaptureKit -framework CoreImage -framework ApplicationServices \
  Protocol.swift FrameWriter.swift Capture.swift WindowFocus.swift Input.swift Main.swift -o build/ace-screen-helper
codesign --force --sign - --identifier dev.ace.screen-helper build/ace-screen-helper
