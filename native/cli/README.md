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
HTTP/1.1, local WS, remote profiles, pinned HTTPS/WSS) is `1.90 MiB` (`1,947.5 KiB`, well under the
4 MB budget). No async runtime (`tokio`/`hyper`/`reqwest`) is in the dependency tree.

| Crate | Features | Why | Size added |
| ----- | -------- | --- | ---------- |
| `serde` | `derive`, `std` (no defaults) | Borrowed deserialization and typed request encoding without DOM allocation | `~0 KiB` (traits + derive; codegen links with `serde_json`) |
| `serde_json` | `std`, `raw_value` (no defaults) | `Box<RawValue>` passthrough for `--json`, envelope peeking, `/v1/*` JSON bodies | `+48.5 KiB` |
| `tungstenite` | `handshake` (no defaults) | Blocking RFC 6455 WebSocket framing and HTTP upgrade over `std::net::TcpStream` / `rustls` | `+113.9 KiB` |
| `rustls` | `ring`, `std`, `tls12` (no defaults) | Pinned TLS 1.2/1.3 for remote machine profiles (`ring` also provides SHA-256 for SPKI pinning) | `+840.8 KiB` |
| `ureq` | `rustls-no-provider` (no defaults) | Blocking HTTP/1.1 client for local and pinned-HTTPS `/v1/*` calls (`rustls-no-provider` avoids `webpki-roots`'s unapproved license) | `+243.4 KiB` |
| `url` | (no defaults) | WHATWG URL parsing and validation for local, remote, and relay origins | `+209.8 KiB` |
| `x509-parser` | (no defaults) | Leaf X.509 DER parsing for SPKI extraction and `[notBefore, notAfter)` validity checks | `+80.8 KiB` |
| `rustls-native-certs` | default | Lazy OS CA root loading for `.ts.net` certificate renewal fallback (ADR 0097) | `+17.8 KiB` |

## Budgets

Measured by `bench/` on release builds (ADR 0221 §5).

| Run | Budget | Measured |
| --- | ------ | -------- |
