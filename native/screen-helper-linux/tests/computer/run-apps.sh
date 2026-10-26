#!/bin/sh
# Live check of `--computer` with everyday apps (apps.py): x,y clicks, menu shortcuts, copy and
# paste, LibreOffice's modules and Chromium-based apps, in a throwaway headless GNOME Shell
# Wayland session (wayland-session.sh). Needs gnome-calculator, mousepad, gnome-text-editor;
# LibreOffice and a Chromium-based app (ACE_TEST_CHROMIUM_APP=<desktop id>) are checked when
# present.
# Usage: tests/computer/run-apps.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
exec tests/computer/wayland-session.sh python3 tests/computer/apps.py "$PWD/target/debug/ace-screen-helper-linux"
