#!/bin/sh
# Build and sign only. Never install a bundle or edit authorization policy here.
set -eu
cd "$(dirname "$0")"
mkdir -p build
identity=${ACE_SCREEN_SIGN_IDENTITY:-}
if [ "${ACE_SCREEN_SIGN_RELEASE:-0}" = 1 ]; then
  identity=$(cat ../screen-helper/build/release-signing-identity)
fi
if [ -z "$identity" ] && [ -f ../screen-helper/build/signing-identity ]; then
  identity=$(cat ../screen-helper/build/signing-identity)
fi
if [ -z "$identity" ] || [ "$identity" = - ]; then
  echo 'locked-use: a real Developer ID signing identity is required' >&2
  exit 1
fi
team=${ACE_LOCKED_USE_TEAM:-}
if [ -z "$team" ]; then
  team=$(codesign -dvv ../screen-helper/build/AceScreenHelper.app 2>&1 | sed -n 's/^TeamIdentifier=//p')
fi
case "$team" in ''|*[!A-Z0-9]*) echo 'locked-use: invalid signing team' >&2; exit 1;; esac
if [ "${#team}" -ne 10 ]; then echo 'locked-use: signing team must contain ten characters' >&2; exit 1; fi
staging=build/AceLockedUseAuthorization.next.bundle
rm -rf "$staging"
mkdir -p "$staging/Contents/MacOS" build/include
cp AuthorizationPlugin-Info.plist "$staging/Contents/Info.plist"
printf '#define ACE_LOCKED_USE_TEAM "%s"\n' "$team" > build/include/LockedUseSigning.h
clang -fobjc-arc -fvisibility=hidden -Wall -Wextra -Werror -mmacosx-version-min=13.0 \
  -bundle -framework Foundation -framework Security -I build/include \
  Sources/AuthorizationPlugin/Plugin.m Sources/AuthorizationPlugin/AuthorizationClient.m \
  -o "$staging/Contents/MacOS/AceLockedUseAuthorization"
timestamp=--timestamp=none
if [ "${ACE_SCREEN_SIGN_RELEASE:-0}" = 1 ]; then timestamp=--timestamp; fi
codesign --sign "$identity" --options runtime "$timestamp" "$staging"
codesign --verify --strict "$staging"
actual_team=$(codesign -dvv "$staging" 2>&1 | sed -n 's/^TeamIdentifier=//p')
if [ "$actual_team" != "$team" ]; then echo 'locked-use: signature does not match pinned team' >&2; exit 1; fi
rm -rf build/AceLockedUseAuthorization.bundle
mv "$staging" build/AceLockedUseAuthorization.bundle
printf '%s\n' 'locked-use: signed authorization component built; not installed or enabled'

swift build -c release --product ace-locked-use-authority --jobs 4
swift build -c release --product ace-locked-use-guardian --jobs 4
for name in ace-locked-use-authority ace-locked-use-guardian; do
  cp ".build/release/$name" "build/$name"
  case "$name" in
    ace-locked-use-authority) identifier=dev.ace.locked-use.authority;;
    *) identifier=dev.ace.locked-use.guardian;;
  esac
  codesign --force --sign "$identity" --identifier "$identifier" --options runtime "$timestamp" "build/$name"
  requirement="anchor apple generic and certificate leaf[subject.OU] = \"$team\" and identifier \"$identifier\""
  codesign --verify --strict -R "$requirement" "build/$name"
done
printf '%s\n' "$team" > build/team
