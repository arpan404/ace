#!/bin/sh
# Live check of `--computer` in a headless GNOME Shell Wayland session (wayland-session.sh).
# Needs also: gnome-calculator, gnome-text-editor, mousepad.
# Usage: tests/computer/run-wayland.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
exec tests/computer/wayland-session.sh python3 tests/computer/wayland.py "$PWD/target/debug/ace-screen-helper-linux"
