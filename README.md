# ace

ace is being rebuilt as a Rust-first monorepo with a native GPUI desktop app,
an in-process runtime for desktop, and a WebSocket protocol reserved for future
mobile and remote clients.

The previous TypeScript/Bun implementation lives in `.old/ts-port/` as
reference-only material. It is not the architecture or code-quality standard for
new Rust work.

## Development

Run the Rust GPUI desktop development app:

```bash
./scripts/desktop:dev
```

For restart-on-change development, install `cargo-watch` and use:

```bash
cargo install cargo-watch
./scripts/desktop:watch
```

The same launchers are exposed as `just` recipes:

```bash
just desktop-dev
just desktop-watch
```

`scripts/desktop:dev` launches `ace-desktop` directly. It does not start the standalone
backend unless remote/mobile WebSocket testing is explicitly requested:

```bash
ACE_START_BACKEND=1 ./scripts/desktop:dev
```

The watch launcher honors the same environment:

```bash
ACE_START_BACKEND=1 ./scripts/desktop:watch
```

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
cargo check --workspace
```

The first desktop client is `apps/desktop`; mobile is reserved for a later app
in the same monorepo.
