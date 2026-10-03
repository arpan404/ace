#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo 'screen writer benchmark: skipped (requires macOS)'; exit 0; fi
cd "$(dirname "$0")"
mkdir -p build
swiftc -swift-version 5 -O -parse-as-library FrameWriter.swift WriterBench.swift -o build/writer-bench
build/writer-bench
