#!/bin/sh
# Prepares a Debian 12 (glibc 2.36) container, as root, to build ace's Linux release:
# the C/C++ toolchain for node-pty, the workspace addon and the terminal guardian, Rust and the
# PipeWire headers for the screen helper, Node 26.12.1 (checksum-pinned, the release runtime),
# and Bun. Everything built here runs on Ubuntu 24.04+, Debian 12+, Fedora and Arch (Omarchy).
# Used by .github/workflows/release.yml and for local builds (tools/release/README.md).
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root inside the debian:12 build container' >&2; exit 1; }
. /etc/os-release
[ "$ID" = debian ] && [ "$VERSION_ID" = 12 ] || { echo 'Expected Debian 12' >&2; exit 1; }

NODE_VERSION=26.12.1
BUN_VERSION=1.4.0
RUST_VERSION=1.91.1
case "$(uname -m)" in
  x86_64) node_arch=x64; node_sha=0fd1eb7770598f52a21995edf6ed35fc690400fa437c2386af329519e9143132;;
  aarch64) node_arch=arm64; node_sha=a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f;;
  *) echo 'Unsupported architecture' >&2; exit 1;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git xz-utils unzip file binutils build-essential python3 pkg-config \
  libpipewire-0.3-dev libspa-0.2-dev
rm -rf /var/lib/apt/lists/*

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
node_archive="node-v$NODE_VERSION-linux-$node_arch.tar.gz"
curl --fail --silent --show-error --location --proto '=https' \
  "https://nodejs.org/dist/v$NODE_VERSION/$node_archive" -o "$scratch/$node_archive"
echo "$node_sha  $scratch/$node_archive" | sha256sum -c -
tar -xzf "$scratch/$node_archive" -C /usr/local --strip-components=1 --no-same-owner

npm install --global "bun@$BUN_VERSION"

curl --fail --silent --show-error --location --proto '=https' https://sh.rustup.rs -o "$scratch/rustup.sh"
sh "$scratch/rustup.sh" -y --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION"
# Later steps need cargo on PATH: GitHub Actions reads GITHUB_PATH, a shell adds it itself.
[ -z "${GITHUB_PATH:-}" ] || echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"
PATH="$HOME/.cargo/bin:$PATH"

node --version
bun --version
cargo --version
ldd --version | head -n 1
