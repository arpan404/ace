#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Build on Linux. Release builds run in the Debian 12 container (tools/release/linux), so the
# helper needs glibc 2.36 or newer. glibc is linked dynamically: a static glibc cannot reliably
# dlopen libpipewire, which only screenshots and live view need (accessibility never does).
case "$(uname -m)" in x86_64) target=x86_64-unknown-linux-gnu;; aarch64) target=aarch64-unknown-linux-gnu;; *) echo 'Unsupported Linux architecture' >&2; exit 1;; esac
[ "$(uname -s)" = Linux ] || { echo 'Use the Linux container to build this helper' >&2; exit 1; }
cargo build --locked --release --target "$target"
mkdir -p build
cp "target/$target/release/ace-screen-helper-linux" "build/ace-screen-helper-linux-$target"
