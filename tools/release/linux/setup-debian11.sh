#!/bin/sh
# Prepares a Debian 11 (glibc 2.31) container, as root, to build ace's Linux release:
# the C/C++ toolchain for node-pty, the workspace addon and the terminal guardian, Rust and the
# PipeWire headers for the screen helper, Node 24.13.0 (checksum-pinned, the release runtime),
# and Bun. Everything built here runs on Ubuntu 20.04+, Debian 11+, Fedora and Arch.
# Used by .github/workflows/release.yml and for local builds (tools/release/README.md).
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root inside the debian:11 build container' >&2; exit 1; }
. /etc/os-release
[ "$ID" = debian ] && [ "$VERSION_ID" = 11 ] || { echo 'Expected Debian 11' >&2; exit 1; }

NODE_VERSION=24.13.0
BUN_VERSION=1.4.0
RUST_VERSION=1.91.1
case "$(uname -m)" in
  x86_64) node_arch=x64; node_sha=6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8;;
  aarch64) node_arch=arm64; node_sha=0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081;;
  *) echo 'Unsupported architecture' >&2; exit 1;;
esac

export DEBIAN_FRONTEND=noninteractive
# Debian 11 has left the regular mirrors (their pools no longer hold its security updates);
# archive.debian.org keeps the final, signed bullseye and bullseye-security suites.
rm -f /etc/apt/sources.list.d/debian.sources
cat > /etc/apt/sources.list <<'EOF'
deb http://archive.debian.org/debian bullseye main
deb http://archive.debian.org/debian-security bullseye-security main
EOF
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
