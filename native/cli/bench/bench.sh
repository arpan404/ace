#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Measures the Rust CLI against the TypeScript one (ADR 0221 §5). A tool, not a test: run it on
# a release build, with a temporary ace home so no daemon of yours is touched.
#
#   native/cli/bench/bench.sh
#   RUNS=100 native/cli/bench/bench.sh
set -eu

repo=$(cd "$(dirname "$0")/../../.." && pwd)
ace=${ACE_CLI_BIN:-"$repo/native/cli/target/release/ace"}
ts=${ACE_CLI_TS:-"$repo/apps/daemon/src/cli.ts"}
bun=${BUN:-$(command -v bun)}
node=${NODE:-$(command -v node)}
home=$(mktemp -d "${TMPDIR:-/tmp}/ace-cli-bench.XXXXXX")
trap 'rm -rf "$home"' EXIT

export ACE_VERSION=${ACE_VERSION:-0.0.25-beta.3}
export ACE_HOME="$home"
export HOME="$home"
export NO_COLOR=1
unset ACE_THREAD_ID ACE_NO_INPUT 2>/dev/null || true

runs=${RUNS:-50}
# A bundle that exits at once: the hand-over's own cost, without the daemon's or Node's work.
printf 'process.exit(0)\n' >"$home/instant.mjs"

echo "Rust:       $ace"
echo "TypeScript: $bun $ts"
echo "Node:       $node"
echo

hyperfine --ignore-failure --shell=none --warmup 10 --runs "$runs" \
  -n "rust  ace version" "$ace version" \
  -n "rust  ace help" "$ace help" \
  -n "rust  ace help thread" "$ace help thread" \
  -n "rust  a usage error" "$ace thraed list" \
  -n "rust  completion, daemon down" "$ace __complete -- thread :s" \
  -n "rust  ace --json (management tree)" "$ace --json" \
  -n "ts    ace version" "$bun $ts version" \
  -n "ts    ace help" "$bun $ts help" \
  -n "ts    ace help thread" "$bun $ts help thread" \
  -n "ts    a usage error" "$bun $ts thraed list" \
  -n "ts    completion, daemon down" "$bun $ts __complete -- thread :s"

echo
# Both run the same trivial bundle on the same Node with the same arguments, so what is left is
# the binary's own start and the exec; `ace version` shows the start alone. The node pass runs
# first, so the binary is measured with everything already in the page cache.
echo "Hand-over: the binary execs a bundle that exits at once, against Node running it alone."
hyperfine --ignore-failure --shell=none --warmup 10 --runs "$runs" \
  -n "node  the instant bundle" "$node --disable-warning=ExperimentalWarning $home/instant.mjs thread list" \
  -n "rust  ace thread list (hands over)" "env ACE_CLI_NODE=$node ACE_CLI_ENTRY=$home/instant.mjs $ace thread list" \
  -n "rust  ace version (the binary's own start)" "$ace version"
