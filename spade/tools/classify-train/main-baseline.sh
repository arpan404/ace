#!/usr/bin/env bash
# The true `main` baseline for the classifier's before/after (ADR 0172, amendment 6): main's
# shipped model (`spade-classify/99f56e23`) run with main's own decision logic, on exactly the
# evaluation sets the shipped weights are measured on. It builds in a clean worktree pinned at the
# branch point, against main's crates, so it uses no API this PR added.
#
#   tools/classify-train/main-baseline.sh /var/tmp/spade-real   # a real-session copy (real-sessions.sh)
#
# First it regenerates the shipped REPORT with CLASSIFY_EVAL_OUT, which writes the deduped public
# evaluation sets (the hand-labelled hard set and tldr-pages' held-out pages, both non-private) so
# the baseline measures the same held-out calls. Real sessions are read only as aggregates, never
# printed. Run from the `spade` folder.
set -euo pipefail

real="${1:?usage: main-baseline.sh REAL_DIR [TLDR_DIR]}"
tldr="${2:-/var/tmp/spade-corpora/tldr}"
base=169f9eaf0f278737436d459f04806cb150c56e5e
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
work="$(mktemp -d /var/tmp/spade-main-baseline.XXXX)"
eval_public="$work/eval-public.tsv"
real_keep="$work/real-keep.ids"

# The deduped public eval sets and the retained real-session ids (opaque `real::identity`
# numbers, never command text), from the shipped build, so the baseline measures the same calls.
CLASSIFY_EVAL_OUT="$eval_public" CLASSIFY_REAL_KEEP="$real_keep" CLASSIFY_SKIP_MLP=1 \
  cargo run --release -q -p classify-train -- \
  --out "$work/shipped" --tldr "$tldr" --real "$real" > /dev/null

# A pristine main worktree, with the harness and the vendored baseline copied in.
git -C "$repo" worktree add -q --detach "$work/main" "$base"
src="$work/main/spade/tools/classify-train/src"
cp "$here/src/hard.rs" "$here/src/tldr.rs" "$here/src/real.rs" "$here/src/label.rs" \
   "$src/"; cp "$here/baseline/connectors.rs" "$src/connectors.rs"
mkdir -p "$src/label" && cp "$here/src/label/tables.rs" "$src/label/"
cp "$here/baseline/baseline.rs" "$src/baseline.rs"
cat >> "$work/main/spade/tools/classify-train/Cargo.toml" <<'TOML'

[[bin]]
name = "baseline"
path = "src/baseline.rs"
TOML

( cd "$work/main/spade" && CARGO_TARGET_DIR="$work/target" \
    cargo run --release -q --bin baseline -- \
    --eval-public "$eval_public" --real "$real" --real-keep "$real_keep" )

git -C "$repo" worktree remove --force "$work/main"
rm -rf "$work"
