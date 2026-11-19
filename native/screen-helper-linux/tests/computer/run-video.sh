#!/bin/sh
# Live check of the session helper's video (video.py) in a throwaway headless GNOME Shell
# Wayland session (wayland-session.sh). Needs also: gnome-calculator, ffmpeg, and Chrome or
# Chromium. On a machine with VA-API or NVIDIA, opt in to the backend under test
# (ACE_SCREEN_VAAPI=1 or ACE_MEDIA_NV=1) and set ACE_E2_EXPECT=vaapi or nv.
# Usage: tests/computer/run-video.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
exec tests/computer/wayland-session.sh python3 tests/computer/video.py "${CARGO_TARGET_DIR:-$PWD/target}/debug/ace-screen-helper-linux"
