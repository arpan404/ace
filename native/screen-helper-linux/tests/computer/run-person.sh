#!/bin/sh
# Live check of the person's side of `--computer` (person.py): the "ace is using" notice and its
# Stop, the session state and lock screen, and keeping the desktop awake, in a throwaway
# headless GNOME Shell Wayland session (wayland-session.sh). Needs also: gnome-calculator,
# gir1.2-atspi-2.0.
# Usage: tests/computer/run-person.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
exec tests/computer/wayland-session.sh python3 tests/computer/person.py "$PWD/target/debug/ace-screen-helper-linux"
