#!/usr/bin/env bash
# Build command for the Cloudflare Pages project that serves app.acehq.dev.
#
# The Pages build image has no Rust, and `bun install` builds markit's Wasm worker
# (packages/markit) in postinstall. That needs Rust with the wasm32 target and
# wasm-bindgen-cli at the version pinned in packages/markit/Cargo.lock, so both
# are installed here before the install and build run.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"

export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
fi
rustup target add wasm32-unknown-unknown

bindgen_version="$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/version = |"/, ""); print; exit }' packages/markit/Cargo.lock)"
if [ -z "$bindgen_version" ]; then
  echo "wasm-bindgen is missing from packages/markit/Cargo.lock" >&2
  exit 1
fi
tools="$HOME/.ace-pages-tools"
export PATH="$tools/bin:$PATH"
if [ "$(wasm-bindgen --version 2>/dev/null | awk '{ print $2 }')" != "$bindgen_version" ]; then
  archive="wasm-bindgen-$bindgen_version-$(uname -m)-unknown-linux-musl"
  mkdir -p "$tools/bin"
  curl -sSfL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$bindgen_version/$archive.tar.gz" |
    tar -xz -C "$tools"
  cp "$tools/$archive/wasm-bindgen" "$tools/bin/wasm-bindgen"
fi
wasm-bindgen --version

bun install --frozen-lockfile
bun run --cwd apps/web build
find apps/web/dist -name '*.map' -delete
