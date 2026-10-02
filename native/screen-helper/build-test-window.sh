#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then exit 0; fi
cd "$(dirname "$0")"
app=build/ScreenTest.app
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.ace.screen-test</string>
<key>CFBundleExecutable</key><string>ScreenTest</string>
<key>CFBundleName</key><string>ace screen test</string>
<key>NSPrincipalClass</key><string>ScreenTestApplication</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
swiftc -swift-version 5 -parse-as-library -framework AppKit TestWindow.swift -o "$app/Contents/MacOS/ScreenTest"
codesign --force --sign - "$app"
