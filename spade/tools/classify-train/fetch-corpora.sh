#!/usr/bin/env bash
# Fetches the public corpora classify-train reads, at the commits the shipped model was trained on
# (crates/spade-classify/model/DATA-LICENSES.md has their licences). Nothing fetched is committed.
#
#   fetch-corpora.sh /var/tmp/spade-corpora
#   cargo run --release -p classify-train -- --tldr /var/tmp/spade-corpora/tldr
set -euo pipefail
out="${1:?usage: fetch-corpora.sh OUT_DIR}"
tldr_commit=70eef449485e3240f3bd00f02734fe12257ed735
mkdir -p "$out"
if [ ! -d "$out/tldr/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/tldr-pages/tldr.git "$out/tldr"
fi
git -C "$out/tldr" fetch --depth 1 origin "$tldr_commit"
git -C "$out/tldr" -c advice.detachedHead=false checkout --quiet "$tldr_commit"
echo "tldr-pages at $(git -C "$out/tldr" rev-parse HEAD) in $out/tldr"
