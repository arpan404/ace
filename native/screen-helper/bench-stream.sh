#!/bin/sh
# Live-view text sharpness and encoder cost, through the helper's own encoders (no capture or
# permissions needed). `sh bench-stream.sh` measures this checkout; `sh bench-stream.sh <dir>`
# measures the encoders in another checkout's native/screen-helper (a "before" run).
set -eu
if [ "$(uname -s)" != Darwin ]; then echo 'stream benchmark: skipped (requires macOS)'; exit 0; fi
here=$(cd "$(dirname "$0")" && pwd)
encoders=${1:-$here}
mkdir -p "$here/build/stream-bench"
cp "$here/StreamBench.swift" "$here/build/stream-bench/main.swift"
if [ "$encoders" = "$here" ]; then
  flags='-D REFINE'
  sources="$here/StreamPolicy.swift"
else
  flags=''
  sources=''
fi
# shellcheck disable=SC2086
swiftc -swift-version 5 -O $flags -framework AppKit -framework CoreImage -framework VideoToolbox \
  $sources "$encoders/Pipeline.swift" "$encoders/VideoEncoder.swift" "$encoders/JPEGEncoder.swift" \
  "$here/build/stream-bench/main.swift" -o "$here/build/stream-bench/stream-bench"
"$here/build/stream-bench/stream-bench"
