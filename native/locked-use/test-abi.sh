#!/bin/sh
# CI-safe component fixture: no signing key, bundle installation or OS policy modification.
set -eu
cd "$(dirname "$0")"
mkdir -p .build/abi/include
printf '#define ACE_LOCKED_USE_TEAM "ACETEST000"\n' > .build/abi/include/LockedUseSigning.h
clang -fobjc-arc -fvisibility=hidden -Wall -Wextra -Werror -mmacosx-version-min=13.0 \
  -bundle -framework Foundation -framework Security -I .build/abi/include \
  Sources/AuthorizationPlugin/Plugin.m Sources/AuthorizationPlugin/AuthorizationClient.m \
  -o .build/abi/unsigned-authorization-fixture.bundle
sh test-plugin.sh "$PWD/.build/abi/unsigned-authorization-fixture.bundle"
