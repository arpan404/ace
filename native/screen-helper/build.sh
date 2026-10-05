#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo 'screen-helper: skipped (requires macOS)'; exit 0; fi
cd "$(dirname "$0")"
mkdir -p build
# Release builds (ACE_SCREEN_SIGN_RELEASE=1, set by `desktop:package --full`) must be
# notarizable: a Developer ID Application identity and a secure timestamp. Local builds keep
# the cached identity and skip the timestamp server.
release=${ACE_SCREEN_SIGN_RELEASE:-0}
if [ "$release" = 1 ]; then
  release_identity=${ACE_SCREEN_SIGN_IDENTITY:-${CSC_NAME:-}}
  if [ -z "$release_identity" ] || ! security find-identity -v -p codesigning 2>/dev/null | grep -F -- "$release_identity" | grep -q 'Developer ID Application'; then
    echo 'screen-helper: release signing needs a "Developer ID Application" identity in the keychain, named by ACE_SCREEN_SIGN_IDENTITY or CSC_NAME' >&2
    exit 1
  fi
fi
sources='Responsibility.swift Protocol.swift FrameChanges.swift Metrics.swift AXAttributes.swift Accessibility.swift JPEGEncoder.swift VideoEncoder.swift FrameWriter.swift Capture.swift WindowFocus.swift Input.swift InputV2.swift Main.swift'
# Cache before compiler, keychain or signing work. Builds are explicit, never a daemon action.
source_hash=$(cat $sources Info.plist build.sh | shasum -a 256 | cut -d ' ' -f 1)
app=build/AceScreenHelper.app
binary="$app/Contents/MacOS/ace-screen-helper"
unchanged=false
if [ -f build/source.hash ] && [ "$(cat build/source.hash)" = "$source_hash" ] && [ -x "$binary" ]; then
  unchanged=true
  if [ "$release" != 1 ] && [ -f build/manifest.json ] && [ -L build/ace-screen-helper ]; then
    echo 'screen-helper: unchanged; build and signature retained'; exit 0
  fi
fi
if [ "$unchanged" = false ]; then
if [ ! -f build/signing-identity ]; then
  identity=${ACE_SCREEN_SIGN_IDENTITY:-}
  if [ -z "$identity" ]; then
    identity=$(security find-identity -v -p codesigning 2>/dev/null | awk 'length($2) == 40 && $2 ~ /^[0-9A-F]+$/ {print $2; exit}')
  fi
  printf '%s\n' "${identity:--}" > build/signing-identity
fi
identity=$(cat build/signing-identity)
staging=build/AceScreenHelper.next.app
rm -rf "$staging"
mkdir -p "$staging/Contents/MacOS"
cp Info.plist "$staging/Contents/Info.plist"
swiftc -swift-version 5 -O -parse-as-library -target "$(uname -m)-apple-macosx13.0" \
  -framework AppKit -framework ScreenCaptureKit -framework CoreImage -framework ApplicationServices -framework VideoToolbox \
  $sources -o "$staging/Contents/MacOS/ace-screen-helper"
unsigned_sha=$(shasum -a 256 "$staging/Contents/MacOS/ace-screen-helper" | cut -d ' ' -f 1)
if [ -f "$binary" ] && [ -f build/unsigned.hash ] && [ "$(cat build/unsigned.hash)" = "$unsigned_sha" ] && cmp -s "$app/Contents/Info.plist" Info.plist; then
  rm -rf "$staging"
else
  # A changed binary is signed once with the persisted choice. No forced re-signing.
  codesign --sign "$identity" --options runtime --timestamp=none "$staging"
  rm -rf "$app"
  mv "$staging" "$app"
fi
printf '%s\n' "$source_hash" > build/source.hash
printf '%s\n' "$unsigned_sha" > build/unsigned.hash
fi
if [ "$release" = 1 ]; then
  codesign --force --sign "$release_identity" --options runtime --timestamp "$app"
fi
sha=$(shasum -a 256 "$binary" | cut -d ' ' -f 1)
plist_sha=$(shasum -a 256 "$app/Contents/Info.plist" | cut -d ' ' -f 1)
# Manifest is outside the sealed app: cache updates cannot invalidate its signature.
printf '{"bundleId":"dev.ace.screen-helper","sha256":"%s","plistSha256":"%s"}\n' "$sha" "$plist_sha" > build/manifest.json
# Compatibility path for v1 launchers; executable bytes still live in the stable app.
ln -sfn AceScreenHelper.app/Contents/MacOS/ace-screen-helper build/ace-screen-helper
