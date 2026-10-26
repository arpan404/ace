#!/bin/sh
# Live check of typing in front (front.py): a Chromium-based app typed into with the
# RemoteDesktop portal's keyboard after an activate step, in a throwaway headless GNOME Shell
# Wayland session (wayland-session.sh). Needs VS Code, gnome-text-editor and gir1.2-atspi-2.0.
# Usage: tests/computer/run-front.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
exec tests/computer/wayland-session.sh python3 tests/computer/front.py "$PWD/target/debug/ace-screen-helper-linux"
