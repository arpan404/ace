# The daemon's Rust core

The event store first ([ADR 0222](../../docs/adr/0222-the-event-store-moves-to-rust-behind-the-same-store.md)),
then the engine and adapters, agent-control and machines, each a crate here.

- `crates/ace-store`: the store as a Rust API. Today, the SQLite connection
  (`src/sqlite.rs`, the crate's only unsafe code) that every daemon connection runs on with
  `ACE_STORE=native`.
- `crates/ace-daemon-node`: the N-API addon the daemon loads; it only translates values,
  errors and handles. Its TypeScript side is `packages/provider-kit/src/native-sqlite.ts`.

Build: `cargo build --release -p ace-daemon-node` (the daemon loads
`target/release/libace_daemon_node.{dylib,so}` or `ace_daemon_node.dll`, or the file named by
`ACE_STORE_ADDON`). Checks: `bun run check:daemon-native`. Proof: the store's TypeScript tests
with `ACE_STORE=native` (docs/store/behaviour.md §15).
