#!/bin/sh
# Exercise the built component against an in-process fake OS engine. No OS policy changes.
set -eu
cd "$(dirname "$0")"
component=${1:-"$PWD/build/AceLockedUseAuthorization.bundle/Contents/MacOS/AceLockedUseAuthorization"}
mkdir -p build
if [ ! -f "$component" ]; then
  echo 'locked-use: run sh native/locked-use/build.sh first' >&2
  exit 1
fi
clang -fobjc-arc -Wall -Wextra -Werror -mmacosx-version-min=13.0 \
  -framework Foundation -framework Security Tests/AuthorizationPlugin/Behavior.m \
  -o build/authorization-behavior
build/authorization-behavior "$component"

# Exercise the same lifecycle with a verified reply fixture, without pretending that this
# bypasses or tests OS peer-signature enforcement. The real built bundle was checked above.
clang -fobjc-arc -Wall -Wextra -Werror -mmacosx-version-min=13.0 -bundle \
  -framework Foundation -framework Security Sources/AuthorizationPlugin/Plugin.m \
  Tests/AuthorizationPlugin/VerifiedAuthorityFixture.m -o build/verified-authority-fixture.bundle
build/authorization-behavior "$PWD/build/verified-authority-fixture.bundle" --verified-authority
