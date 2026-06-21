# ace

ace is being rebuilt as a native Rust monorepo with a GPUI desktop app, a local
runtime/server, and a protocol designed for future mobile clients.

The previous TypeScript/Bun implementation lives in `.old/ts-port/` as
reference-only material. It is not the architecture or code-quality standard for
new Rust work.

## Development

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check --workspace
```

The first runnable target is `apps/desktop`; mobile is reserved for a later app
in the same monorepo.

