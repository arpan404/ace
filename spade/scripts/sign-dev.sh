#!/usr/bin/env bash
# Signs a local Spade build with a stable identity, so a rebuilt binary keeps the same designated
# requirement and its keychain entries stay readable without a prompt (ADR 0119 amendment 1,
# spade/docs/dev-signing.md). macOS only; elsewhere it does nothing.
#
#   spade/scripts/sign-dev.sh [binary]     default: spade/target/release/spade
#
# Identity: $SPADE_SIGN_IDENTITY if set, else the first "Apple Development" identity, else a
# self-signed "Spade Local Dev" certificate if one exists. The Developer ID is never picked
# unasked: a Developer ID signed build counts as the release Spade and, on the live home, would
# use the live keychain entries.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "sign-dev: not macOS, nothing to sign"
  exit 0
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
binary="${1:-$here/target/release/spade}"
if [[ ! -f "$binary" ]]; then
  echo "sign-dev: no binary at $binary (build it first: cargo build --release -p spade-server)" >&2
  exit 1
fi

identities="$(security find-identity -v -p codesigning)"
# No match is a normal answer, not a failure (set -e and pipefail would end the script on it).
pick() { { grep -o "\"$1[^\"]*\"" <<<"$identities" || true; } | head -n 1 | tr -d '"'; }
identity="${SPADE_SIGN_IDENTITY:-}"
[[ -n "$identity" ]] || identity="$(pick "Apple Development")"
[[ -n "$identity" ]] || identity="$(pick "Spade Local Dev")"
if [[ -z "$identity" ]]; then
  echo "sign-dev: no stable signing identity found; see spade/docs/dev-signing.md" >&2
  exit 1
fi

codesign --force --sign "$identity" --identifier spade --timestamp=none "$binary"
echo "sign-dev: signed $binary with \"$identity\""
codesign -d -r- "$binary" 2>&1 | grep '^designated' || true
