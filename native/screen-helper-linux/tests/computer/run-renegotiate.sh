#!/bin/sh
# Live check that renegotiating PipeWire buffers while one is held is safe (renegotiate.py), in
# a throwaway headless GNOME Shell Wayland session. The helper is built with AddressSanitizer in
# its C shell (pipewire.c), so a removed buffer touched again aborts the helper.
# Needs also: python3-gi with GTK 4, gcc's libasan.
# Usage: tests/computer/run-renegotiate.sh   (from native/screen-helper-linux)
set -eu
cd "$(dirname "$0")/../.."
target=${CARGO_TARGET_DIR:-$PWD/target}/asan
# An explicit --target keeps the sanitizer flags off the build scripts.
triple=$(rustc -vV | sed -n 's/^host: //p')
CFLAGS="-fsanitize=address -fno-omit-frame-pointer -g" \
  RUSTFLAGS="-C link-arg=-Wl,--no-as-needed -C link-arg=-lasan" CARGO_TARGET_DIR=$target \
  cargo build --quiet --bin ace-screen-helper-linux --target "$triple"
data=$(mktemp -d)
mkdir -p "$data/applications"
printf '[Desktop Entry]\nType=Application\nName=Grow fixture\nExec=python3 %s\n' \
  "$PWD/tests/computer/grow_window.py" >"$data/applications/dev.ace.GrowFixture.desktop"
export ACE_GROW_DESKTOP_FILE="$data/applications/dev.ace.GrowFixture.desktop"
export XDG_DATA_DIRS="$data:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export ASAN_OPTIONS=verify_asan_link_order=0:detect_leaks=0:abort_on_error=1
status=0
tests/computer/wayland-session.sh python3 tests/computer/renegotiate.py "$target/$triple/debug/ace-screen-helper-linux" || status=$?
rm -rf "$data"
exit $status
