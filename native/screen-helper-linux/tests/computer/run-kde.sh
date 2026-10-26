#!/bin/sh
# Live check of `--computer` on KDE Plasma 6 (kde.py) in a throwaway headless session
# (kde-session.sh). Needs also: kcalc, kwrite, kate, gir1.2-atspi-2.0.
# Usage: tests/computer/run-kde.sh [wayland|x11]   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
cargo build --quiet
exec tests/computer/kde-session.sh "${1:-wayland}" python3 tests/computer/kde.py "$PWD/target/debug/ace-screen-helper-linux"
