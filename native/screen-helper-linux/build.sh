#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Build on Linux, including Debian containers. The executable is installed once by release packaging.
case "$(uname -m)" in x86_64) target=x86_64-unknown-linux-gnu;; aarch64) target=aarch64-unknown-linux-gnu;; *) echo 'Unsupported Linux architecture' >&2; exit 1;; esac
[ "$(uname -s)" = Linux ] || { echo 'Use the Linux container to build this helper' >&2; exit 1; }
RUSTFLAGS='-C target-feature=+crt-static' cargo build --locked --release --target "$target"
mkdir -p build
cp "target/$target/release/ace-screen-helper-linux" "build/ace-screen-helper-linux-$target"
