#!/bin/sh
# The daemon's real ComputerClient and screen_* tools against the Linux helper, in a throwaway
# headless GNOME Shell Wayland session (wayland-session.sh) with GNOME Calculator. Needs
# `bun install` at the repo root first.
# Usage: tests/computer/run-client-e2e.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
exec tests/computer/wayland-session.sh sh -c 'gnome-calculator >/dev/null 2>&1 & sleep 3; node tests/computer/client-e2e.ts "$0"' "$PWD/target/debug/ace-screen-helper-linux"
