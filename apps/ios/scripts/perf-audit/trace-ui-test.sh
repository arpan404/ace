#!/bin/zsh
# Runs one UI test from the built AcePerf products and attaches Instruments to the app it launches,
# by the app's PID on the given simulator only (never by process name).
# Usage: trace-ui-test.sh UDID DERIVED_DATA TEST_ID TEMPLATE SECONDS OUT.trace [DELAY_AFTER_LAUNCH]
# Env: TEST_RUNNER_ACE_IOS_SPIKE_PORT etc. pass through to the test runner.
set -u
udid=$1; dd=$2; test_id=$3; template=$4; seconds=$5; out=$6; delay=${7:-0}
here=${0:a:h}/../..
cd "$here"
lockf -k /tmp/ace-ios-build.lock xcodebuild test-without-building -project Ace.xcodeproj -scheme AcePerf \
  -configuration Perf -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$dd" \
  -parallel-testing-enabled NO -only-testing:"$test_id" ARCHS=arm64 > "${out%.trace}.test.log" 2>&1 &
runner=$!
# The shared build lock can hold the run for a while: wait for the test to launch the app.
until grep -q "Launch app.ace.ios" "${out%.trace}.test.log" 2>/dev/null; do
  kill -0 $runner 2>/dev/null || { echo "runner exited"; exit 1; }; sleep 1
done
pid=""
for _ in $(seq 1 240); do
  pid=$(xcrun simctl spawn "$udid" launchctl list 2>/dev/null | awk '$3 ~ /app\.ace\.ios/ && $1 ~ /^[0-9]+$/ {print $1}' | head -1)
  [[ -n "$pid" ]] && break
  sleep 0.5
done
if [[ -z "$pid" ]]; then echo "app never launched"; wait $runner; exit 1; fi
sleep "$delay"
echo "attaching $template to pid $pid on $udid"
xcrun xctrace record --template "$template" --device "$udid" --attach "$pid" --time-limit "${seconds}s" \
  --output "$out" --no-prompt > "${out%.trace}.xctrace.log" 2>&1
echo "trace done: $out"
wait $runner
echo "test exit $?"
