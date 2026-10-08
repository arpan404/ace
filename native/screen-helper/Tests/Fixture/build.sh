#!/bin/sh
set -eu
cd "$(dirname "$0")"
app=../../build/IdentityFixture.app
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.ace.identity-fixture</string>
<key>CFBundleExecutable</key><string>IdentityFixture</string>
<key>CFBundleName</key><string>ace identity fixture</string>
<key>NSPrincipalClass</key><string>IdentityApplication</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>ace-fixture</string></array></dict></array>
</dict></plist>
PLIST
swiftc -swift-version 5 -parse-as-library -framework AppKit IdentityApp.swift -o "$app/Contents/MacOS/IdentityFixture"
codesign --force --sign - "$app"
