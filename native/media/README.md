<!-- SPDX-License-Identifier: Apache-2.0 -->

# ace-media

The independent Cargo workspace for [ADR 0147](../../docs/adr/0147-ace-media-rust-media-pipeline.md).
The `ace-media` binary speaks the control protocol (M7): `init` and `ready`, the authenticated
priority and egress lanes, ingest on its socket and loopback WebSocket, grants and
revocations, and the privacy barrier in front of a recorder seam. Encoders, viewers, the relay,
recordings and stills land in later PRs.

Rust 1.95.0 is pinned with rustfmt and clippy, matching Spade. The minimum supported Rust
version is 1.87, matching the build plan and Linux helper. All crates inherit the workspace
license and lints. Unsafe code is denied by default; platform bindings may need reviewed
exceptions later.

From this directory:

```sh
cargo fmt --check
cargo clippy --all-targets
cargo test --workspace
cargo run --locked -p ace-media
```

From the repository root, `bun run check:media` runs formatting, clippy, workspace tests,
and the cargo-deny license and source checks. The root `bun run check` includes this local
entry point. Run macOS checks on the Mac and Windows checks in the Windows VM.
`bun run check:media` also builds the binary and runs `@ace/media`'s supervisor process test
against it. To run that test alone, name the binary in `ACE_MEDIA_TEST_BINARY`:

```sh
cargo build -p ace-media
ACE_MEDIA_TEST_BINARY=$PWD/target/debug/ace-media \
  bun --bun x vitest run ../../packages/media/src/supervisor.process.test.ts
```

Install cargo-deny with
`cargo install cargo-deny --version 0.20.2 --locked` first. The check fails if it is missing.

`deny.toml` allows the plan's permissive licenses and only
the crates.io registry. MPL-2.0 dependencies must be limited to development use, with an
explicit exception added when needed; it is not allowed globally. GPL, LGPL and AGPL are
not allowed. Implementations must follow the plan's clean-room rule.

The library crates are `media-core`, `media-wire`, `media-mp4`, `media-noise`,
`media-codec`, `media-vt`, `media-mf`, `media-vaapi`, `media-bitstream`, and
`media-chrome`. Pure crates will keep decision logic separate from platform I/O.
See [the build plan](../../docs/media/plan.md) for each crate's scope.

No benchmarks exist in M0. Later phases add benchmark examples run with
`cargo run --release --example <name>`.
