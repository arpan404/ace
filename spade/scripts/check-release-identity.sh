#!/usr/bin/env bash
# Checks, before a release ships, that its signed Spade keeps reading the keychain entries earlier
# releases made without a prompt (ADR 0119 amendment 1):
#   1. it satisfies Spade's release requirement (crates/spade-keys/release-requirement.txt), so
#      it files under the live service and may open the live home;
#   2. it satisfies each earlier release's designated requirement, which is what those
#      releases' keychain entries trust.
#
#   spade/scripts/check-release-identity.sh <new spade> [earlier spade ...]
#   e.g. ... dist/spade ~/.ace/releases/spade/*/spade
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <new spade> [earlier spade ...]" >&2
  exit 2
fi
here="$(cd "$(dirname "$0")/.." && pwd)"
new="$1"
shift
failed=0

release="$(cat "$here/crates/spade-keys/release-requirement.txt")"
if codesign -v -R "=$release" "$new" 2>/dev/null; then
  echo "ok: $new satisfies the release requirement"
else
  echo "FAIL: $new does not satisfy the release requirement; it would file under the dev service and refuse the live home" >&2
  failed=1
fi

for earlier in "$@"; do
  requirement="$(codesign -d -r- "$earlier" 2>&1 | sed -n 's/^designated => //p')"
  if [[ -z "$requirement" ]]; then
    echo "FAIL: no designated requirement in $earlier" >&2
    failed=1
  elif codesign -v -R "=$requirement" "$new" 2>/dev/null; then
    echo "ok: $new satisfies the requirement of $earlier"
  else
    echo "FAIL: $new does not satisfy the requirement of $earlier; its keychain entries would prompt" >&2
    failed=1
  fi
done
exit "$failed"
