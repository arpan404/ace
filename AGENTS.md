# AGENTS.md

## Active Codebase

ace is now a Rust-first monorepo. The active product is a native GPUI desktop
app with a local runtime/server and a protocol designed for future mobile
clients.

The archived TypeScript/Bun project lives in `.old/ts-port/`. It is
reference-only material for behavior and migration clues. Do not treat it as the
architecture, performance, maintainability, or code-quality standard for the new
Rust codebase.

## Task Completion Requirements

- `cargo fmt --all -- --check` must pass.
- `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- `cargo test --workspace --all-targets` must pass.
- `cargo check --workspace` must pass.
- When intentionally inspecting or validating `.old/ts-port/`, keep its old rule:
  never run `bun test`; use `bun run test`.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures.
4. Keep provider integration maintainable as CLIs add new features.

Choose correctness, resource control, and smooth UI behavior over short-term
convenience.

## Architecture Requirements

- GPUI render paths must not perform filesystem, database, network, process, or
  heavy formatting work.
- Background work belongs in the runtime/server task graph, not UI components.
- Use bounded queues and explicit backpressure for streams.
- Durable domain events must not be dropped; UI projection updates may coalesce.
- Provider integrations must be capability-driven and versioned, so features
  like subagents, multiple threads, background tasks, approvals, model switching,
  attachments, and provider-native tools can be added without duplicating
  orchestration logic.
- Shared behavior belongs in crates, not app-local modules.
- Workspace crate folders use plain domain names such as `crates/core`,
  `crates/git`, and `crates/runtime`; package names may keep the `ace-` prefix.

## Performance And Testing

Performance-sensitive or high-volume code needs a benchmark or documented
measurement before it is considered complete. This especially applies to event
append/replay, projection reducers, protocol serialization, WebSocket fanout,
terminal/log parsing, provider stream normalization, and large GPUI view-model
updates.

## Archive Rules

- `.old/` is tracked archive content and must not be added to `.gitignore`.
- Avoid editing `.old/ts-port/` unless the task explicitly concerns the archive.
