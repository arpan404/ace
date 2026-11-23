# ace-cli

The `ace` command-line tool, in Rust ([ADR 0221](../../docs/adr/0221-the-ace-cli-is-a-rust-management-tool.md)).
It runs ported commands itself and hands every other command to the bundled runtime.

## Dependencies

Every dependency is listed here with why it is needed and what it adds to the stripped release
binary (ADR 0221 §5).

| Crate | Why | Size added |
| ----- | --- | ---------- |

### `cli-wire`

Measured on `aarch64-apple-darwin` with the workspace `[profile.release]` (`opt-level = 3`,
`lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`), incremental over an empty
`std` binary (`295.5 KiB`). A stripped binary exercising the full `cli-wire` surface (local
HTTP/1.1, local WS, remote profiles, pinned TLS) is `1.38 MiB` (`1,412.0 KiB`).

| Crate | Features | Why | Size added |
| ----- | -------- | --- | ---------- |
| `serde` | `derive`, `std` (no defaults) | Borrowed deserialization and typed request encoding without DOM allocation | `~0 KiB` (traits + derive; codegen links with `serde_json`) |
| `serde_json` | `std`, `raw_value` (no defaults) | `Box<RawValue>` passthrough for `--json`, envelope peeking, `/v1/*` JSON bodies | `+48.5 KiB` |
| `tungstenite` | `handshake` (no defaults) | Blocking RFC 6455 WebSocket framing and HTTP upgrade over `std::net::TcpStream` | `+113.9 KiB` |
| `rustls` | `ring`, `std`, `tls12` (no defaults) | Pinned TLS 1.2/1.3 for remote machine profiles (`ring` also provides SHA-256 for SPKI pinning; no extra X.509 or hash crate) | `+840.8 KiB` |

## Budgets

Measured by `bench/` on release builds (ADR 0221 §5).

| Run | Budget | Measured |
| --- | ------ | -------- |
