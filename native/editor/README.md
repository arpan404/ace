# ace editor core

The editor's text core, built to Wasm for the desktop and web clients: buffer, edits, undo,
selections, find and gutter marks. Highlighting comes from markit. Decision: [ADR 0178](../../docs/adr/0178-rust-files-and-editor-core.md).
Build plan and crate contracts: [docs/files/plan.md](../../docs/files/plan.md).

Checks: `bun run check:editor` (fmt, clippy, tests, cargo-deny) on the toolchain in
`rust-toolchain.toml`.
