<!-- SPDX-License-Identifier: Apache-2.0 -->

# ace-media

The independent Cargo workspace for [ADR 0147](../../docs/adr/0147-ace-media-rust-media-pipeline.md).
M0 contains empty library crates and an `ace-media` binary that exits successfully without
reading or writing stdio. No media or control-protocol logic is implemented yet.

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
and the cargo-deny license and source checks. Install cargo-deny with
`cargo install cargo-deny --version 0.20.2 --locked` first. The check fails if it is missing.

There are no dependencies yet. `deny.toml` allows the plan's permissive licenses and only
the crates.io registry. MPL-2.0 dependencies must be limited to development use, with an
explicit exception added when needed; it is not allowed globally. GPL, LGPL and AGPL are
not allowed. Implementations must follow the plan's clean-room rule.

The library crates are `media-core`, `media-wire`, `media-mp4`, `media-noise`,
`media-codec`, `media-vt`, `media-mf`, `media-vaapi`, `media-bitstream`, and
`media-chrome`. Pure crates will keep decision logic separate from platform I/O.
See [the build plan](../../docs/media/plan.md) for each crate's scope.

No benchmarks exist in M0. Later phases add benchmark examples run with
`cargo run --release --example <name>`.
