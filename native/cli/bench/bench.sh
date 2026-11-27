#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Measures the Rust CLI against the TypeScript one (ADR 0221 §5) and enforces its budgets. A
# tool, not a test: run it on a release build, with a temporary ace home so no daemon is touched.
#
#   native/cli/bench/bench.sh
#   RUNS=100 native/cli/bench/bench.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
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

# Every benchmarked command must do what it is named for before its time means anything.
expect() {
  want=$1
  shift
  set +e
  "$@" >/dev/null 2>&1
  got=$?
  set -e
  if [ "$got" -ne "$want" ]; then
    echo "bench: '$*' exited $got, expected $want" >&2
    exit 1
  fi
}
expect 0 "$ace" version
expect 0 "$ace" help
expect 0 "$ace" help thread
expect 64 "$ace" thraed list
expect 0 "$ace" __complete -- thread :s
expect 0 "$ace" --json
expect 0 "$bun" "$ts" version
expect 0 env ACE_CLI_NODE="$node" ACE_CLI_ENTRY="$home/instant.mjs" "$ace" thread list
expect 0 "$node" --disable-warning=ExperimentalWarning "$home/instant.mjs" thread list

size=$(wc -c <"$ace" | tr -d ' ')
if [ "$size" -ge 4194304 ]; then
  echo "bench: the binary is $size bytes, over the 4 MB budget" >&2
  exit 1
fi
echo "Rust:       $ace ($size bytes)"
echo "TypeScript: $bun $ts"
echo "Node:       $node"
echo

# --ignore-failure keeps hyperfine running; `expect` above already proved every exit code.
hyperfine --ignore-failure --shell=none --warmup 20 --runs "$runs" \
  --export-json "$home/timings.json" \
  -n "version" "$ace version" \
  -n "help" "$ace help" \
  -n "help thread" "$ace help thread" \
  -n "usage error" "$ace thraed list" \
  -n "completion (daemon down)" "$ace __complete -- thread :s" \
  -n "management tree" "$ace --json" \
  -n "ts version" "$bun $ts version" \
  -n "ts help" "$bun $ts help" \
  -n "ts help thread" "$bun $ts help thread" \
  -n "ts usage error" "$bun $ts thraed list" \
  -n "ts completion (daemon down)" "$bun $ts __complete -- thread :s"

echo
# Both run the same trivial bundle on the same Node with the same arguments, so what is left is
# the binary's own start and the exec; `ace version` shows the start alone. The node pass runs
# first, so the binary is measured with everything already in the page cache.
echo "Hand-over: the binary execs a bundle that exits at once, against Node running it alone."
hyperfine --ignore-failure --shell=none --warmup 20 --runs "$runs" \
  --export-json "$home/handover.json" \
  -n "node instant bundle" "$node --disable-warning=ExperimentalWarning $home/instant.mjs thread list" \
  -n "ace hand-over" "env ACE_CLI_NODE=$node ACE_CLI_ENTRY=$home/instant.mjs $ace thread list" \
  -n "ace start (version)" "$ace version"

echo
node "$here/check.mjs" "$home/timings.json" "$home/handover.json"
