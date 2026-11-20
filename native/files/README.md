# ace-files

The daemon's file system process: listing, watching, the quick-open index, content search and
file I/O for every checkout. Decision: [ADR 0178](../../docs/adr/0178-rust-files-and-editor-core.md).
Build plan and crate contracts: [docs/files/plan.md](../../docs/files/plan.md).

Checks: `bun run check:files` (fmt, clippy, tests, cargo-deny) on the toolchain in
`rust-toolchain.toml`.
