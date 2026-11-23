# ace-cli

The `ace` command-line tool, in Rust ([ADR 0221](../../docs/adr/0221-the-ace-cli-is-a-rust-management-tool.md)).
It runs ported commands itself and hands every other command to the bundled runtime.

## Dependencies

Every dependency is listed here with why it is needed and what it adds to the stripped release
binary (ADR 0221 §5).

| Crate | Why | Size added |
| ----- | --- | ---------- |

## Budgets

Measured by `bench/` on release builds (ADR 0221 §5).

| Run | Budget | Measured |
| --- | ------ | -------- |
