#!/bin/zsh
# Launches the installed fixture build N times on one simulator and prints the app's own launch
# milestones (LaunchTrace, category "launch") for each run, in ms since process start.
# Usage: launch-times.sh UDID RUNS OUT_DIR [extra launch args...]
# Cold = first run after `simctl shutdown`/boot is not forced here; pass COLD=1 to reboot the
# simulator before every run (slow, but it empties the file cache).
set -u
udid=$1; runs=$2; out=$3; shift 3
mkdir -p "$out"
for i in $(seq 1 "$runs"); do
  xcrun simctl terminate "$udid" app.ace.ios >/dev/null 2>&1
  if [[ "${COLD:-0}" == 1 ]]; then
    xcrun simctl shutdown "$udid" >/dev/null 2>&1; xcrun simctl boot "$udid"; sleep 20
  else
    sleep 2
  fi
  log="$out/launch-$i.log"
  xcrun simctl spawn "$udid" log stream --style compact \
    --predicate 'subsystem == "app.ace.ios" && (category == "launch" || category == "perf")' > "$log" 2>&1 &
  streamer=$!
  sleep 1
  xcrun simctl launch "$udid" app.ace.ios "$@" >/dev/null
  sleep "${WAIT:-8}"
  kill "$streamer" 2>/dev/null
  echo "== run $i"
  grep -oE '(vm\.create|script\.evaluate|inbox\.[A-Za-z]+|[a-z]+\.[A-Za-z.]+) [0-9.→]+ms( \([0-9.]+ms\))?' "$log" | head -30
done
