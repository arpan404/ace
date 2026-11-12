#!/usr/bin/env bash
# Build command for the Cloudflare Pages project that serves app.acehq.dev.
#
# markit, the Markdown renderer, installs prebuilt from its GitHub release (`@markit/web` in
# packages/markit-web), so the Pages image needs no Rust or wasm-bindgen.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"

bun install --frozen-lockfile
bun run --cwd apps/web build
find apps/web/dist -name '*.map' -delete
