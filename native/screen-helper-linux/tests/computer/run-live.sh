#!/bin/sh
# Live check of `ace-screen-helper-linux --computer` against real GTK apps, in a throwaway
# headless GNOME Shell Wayland session (wayland-session.sh).
# Needs also: gnome-text-editor, gnome-calculator, mousepad.
# Usage: tests/computer/run-live.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
exec tests/computer/wayland-session.sh python3 tests/computer/live.py "$PWD/target/debug/ace-screen-helper-linux"
