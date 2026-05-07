#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

arch="${ACE_DESKTOP_ARCH:-x64}"
target="${ACE_DESKTOP_TARGET:-AppImage}"
output_dir="${ACE_DESKTOP_OUTPUT_DIR:-release}"
image="${ACE_DESKTOP_DOCKER_IMAGE:-ace-desktop-linux-builder:local}"

case "$arch" in
  x64)
    docker_platform="linux/amd64"
    ;;
  arm64)
    docker_platform="linux/arm64"
    ;;
  *)
    echo "Unsupported ACE_DESKTOP_ARCH '$arch'. Use x64 or arm64." >&2
    exit 1
    ;;
esac

if [[ "$output_dir" = /* ]]; then
  echo "ACE_DESKTOP_OUTPUT_DIR must be relative to the repo when building in Docker." >&2
  exit 1
fi

docker build \
  --platform "$docker_platform" \
  --file "$repo_root/scripts/docker/desktop-linux.Dockerfile" \
  --tag "$image" \
  "$repo_root/scripts/docker"

docker run --rm \
  --platform "$docker_platform" \
  --env ACE_DESKTOP_ARCH="$arch" \
  --env ACE_DESKTOP_TARGET="$target" \
  --env ACE_DESKTOP_OUTPUT_DIR="/workspace/$output_dir" \
  --env APPIMAGE_EXTRACT_AND_RUN=1 \
  --volume "$repo_root:/workspace" \
  --volume "ace-desktop-linux-node-modules-$arch:/workspace/node_modules" \
  --volume "ace-desktop-linux-bun-cache:/root/.bun/install/cache" \
  "$image" \
  bash -lc 'git config --global --add safe.directory /workspace && bun install --frozen-lockfile && bun run dist:desktop:artifact -- --platform linux --target "$ACE_DESKTOP_TARGET" --arch "$ACE_DESKTOP_ARCH" --output-dir "$ACE_DESKTOP_OUTPUT_DIR" "$@"' \
  bash \
  "$@"
