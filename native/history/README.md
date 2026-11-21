# ace-history

The daemon's saved-history reader: inventory scans, the catalog and archive SQLite index,
provider-database snapshots and the Claude Code and Codex readers. Decision:
[ADR 0207](../../docs/adr/0207-rust-history-reader.md).

- `crates/history-wire`: the framed stdio protocol the daemon speaks (`packages/history-import/src/rust/`).
- `crates/history-text`: text rules shared with TypeScript, pinned by `vectors/`.
- `crates/ace-history`: the process.

Checks: `bun run check:history` (fmt, clippy, tests, cargo-deny) on the toolchain in
`rust-toolchain.toml`. Vectors: `bun packages/history-import/scripts/vectors.ts` regenerates them
from the TypeScript; a test there fails when they are stale.
