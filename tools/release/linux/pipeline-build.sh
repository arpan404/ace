#!/bin/sh
# Builds one Linux architecture's part of a release in a fresh Debian 12 container, as the
# release pipeline does on omarchy (ADR 0188), then checks the packages in a fresh Ubuntu 24.04
# container, the oldest supported system:
#
#   tools/release/linux/pipeline-build.sh <x64|arm64> <tag> <key folder>
#
# The key folder holds public.pem, and private.pem for a stable release's signed daemon archive;
# it is mounted read-only. arm64 runs under qemu-user emulation on an x86_64 host (binfmt_misc),
# because Linux natives are built on their own architecture (ADR 0093). Containers run under
# rootless podman by default; ACE_CONTAINER_ENGINE=docker uses Docker instead. The staged
# release lands in dist/releases/<tag>, as on every other host.
set -eu
arch=${1:?usage: pipeline-build.sh <x64|arm64> <tag> <key folder>}
tag=${2:?tag}
keys=${3:?key folder}
engine=${ACE_CONTAINER_ENGINE:-podman}
case "$arch" in
  x64) platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "Unknown architecture $arch" >&2; exit 1 ;;
esac
workspace=$(pwd)
private_key=
[ -f "$keys/private.pem" ] && private_key=/keys/private.pem

# The build: the same steps as on any host, inside Debian 12 (glibc 2.36).
"$engine" run --rm --platform "$platform" \
  --volume "$workspace:/work" --volume "$keys:/keys:ro" --workdir /work \
  --env TAG="$tag" --env TARGET="linux-$arch" \
  --env ACE_RELEASE_PUBLIC_KEY_FILE=/keys/public.pem \
  --env ACE_RELEASE_PRIVATE_KEY_FILE="$private_key" \
  docker.io/library/debian:12 sh -euc '
    sh tools/release/linux/setup-debian12.sh
    export PATH="$HOME/.cargo/bin:$PATH"
    git config --global --add safe.directory /work
    bun install --frozen-lockfile
    node apps/desktop/scripts/pipeline/build.ts "$TAG"
    # A stable release ships the standalone daemon archive: check its glibc floor too.
    if [ -d "tools/release/dist/$TARGET" ]; then
      node tools/release/src/glibc-check.ts "tools/release/dist/$TARGET"
    fi
  '

# The packages on Ubuntu 24.04: the deb installs its command (never /usr/bin/ace) and the
# AppImage holds the app, its screen helper, daemon and runtime.
"$engine" run --rm --platform "$platform" \
  --volume "$workspace/dist/releases/$tag:/release:ro" \
  docker.io/library/ubuntu:24.04 sh -euc '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq /release/*.deb >/dev/null
    test -x /usr/bin/ace-desktop
    test ! -e /usr/bin/ace
    cd "$(mktemp -d)"
    cp /release/*.AppImage app.AppImage
    chmod +x app.AppImage
    ./app.AppImage --appimage-extract >/dev/null
    test -x squashfs-root/ace-desktop
    test -x squashfs-root/resources/helpers/ace-screen-helper-linux
    test -f squashfs-root/resources/daemon/ace.mjs
    test -x squashfs-root/resources/runtime/bin/node
    echo "packages verified on Ubuntu 24.04"
  '
