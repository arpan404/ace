#!/usr/bin/env bash
# Builds the web app that app.acehq.dev serves (Cloudflare Pages project `ace-web`). The release
# workflow's deploy-web job runs it with ACE_VERSION set to the release's version, so the app names
# itself `web/<version>` to ace cloud (ADR 0189), then deploys `apps/web/dist` with wrangler
# (ADR 0188). Pages' own Git builds, if kept for pull-request previews, run it without a version.
#
# markit, the Markdown renderer, installs prebuilt from its GitHub release (`@markit/web` in
# packages/markit-web), so the Pages image needs no Rust or wasm-bindgen.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"

bun install --frozen-lockfile
bun run --cwd apps/web build
find apps/web/dist -name '*.map' -delete
