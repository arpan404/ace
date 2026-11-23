# ace-cli

The `ace` command-line tool, in Rust ([ADR 0221](../../docs/adr/0221-the-ace-cli-is-a-rust-management-tool.md)).
It runs ported commands itself and hands every other command to the bundled runtime.

```sh
bun run cli:table         # regenerate native/cli/table.json from the TypeScript table
bun run check:cli         # table freshness, fmt, clippy, tests, licences
native/cli/bench/bench.sh # hyperfine against the TypeScript CLI (release build)
```

## Crates

| Crate | What it does |
| ----- | ------------ |
| `cli-table` | The command table as static data. `build.rs` turns `native/cli/table.json` into `&'static` arrays with routes sorted for binary search, so a run parses no JSON and builds no index. |
| `cli-parse` | The pure parser: nouns, noun defaults, aliases (`insertWords`, `wordsAs`, `renameFlags`, `setFlags`, `byFlag`), global flags, values, choices, repeats, `-` words, missing arguments, typo suggestions and the usage messages and codes. |
| `cli-out` | Who is on the other end (`--json`, `--quiet`, `--jq`, terminal checks), the failure envelope, exit codes and one locked `BufWriter` per run. |
| `ace-cli` | The `ace` binary: parse, run what is ported, otherwise hand the unchanged arguments to the bundle. |

## What runs here, and what hands over

Runs natively, touching only the static table (ADR 0221 step 2):

- `ace help`, `ace help COMMAND`, `ace help NOUN`, `ace help TOPIC`, `ace help topics`, `ace help flags`, `ace help exit-codes`, `ace help --json`, `ace --json`
- `--help` on every command and noun
- `ace version`, `--version`, `-v`, `--V`
- `ace completion bash|zsh|fish|powershell`, `ace completion install`
- `ace __complete`, as long as the word being completed does not name a live reference
- bare `ace` off a terminal: the overview

Hands over: every other command, and these cases even for the commands above:

- `--jq` anywhere (the filter is jq's to compile and run)
- `help --schema` (the schemas are Zod, in the bundle)
- a missing required argument on a terminal (the bundle asks for it)
- an old spelling (`parsed.alias`), so its notice or refusal is printed once, by the bundle
- a completion slot that names a live reference (thread, project, request, bot): the daemon
  connection lands in ADR 0221 step 3, then these answer here too
- the interactive home, when a person is at a terminal

`ace status --json` and every other daemon command still hand over, so ADR 0221 §5's
"under 15 ms plus the daemon's own time" budget is for step 3, not this one.

Hand-over finds the runtime and `ace.mjs` beside the binary, in both shipped layouts:

- a release: `<release>/bin/ace`, `<release>/bin/node`, `<release>/ace.mjs`
- the desktop app: `…/Resources/bin/ace`, `…/Resources/runtime/bin/node`,
  `…/Resources/daemon/ace.mjs` (`node.exe` on Windows)

It runs `node --disable-warning=ExperimentalWarning ace.mjs ARGS…`, the same flag the current
shim passes: `exec` on Unix (arguments, stdio, signals and exit code are the child's), and on
Windows a child with inherited stdio whose exit code ends the process, with a Ctrl+C handler so
the child receives the event and the parent lives to report its code. `ACE_CLI_NODE` and
`ACE_CLI_ENTRY` override both paths for development and tests only; no launcher sets them.

## The table

`bun run cli:table` writes `native/cli/table.json` from the TypeScript table
(`commandTable()`, global flags, nouns, topics, exit codes). It is checked in;
`check:cli` fails when it is stale. `cli-table/build.rs` fails the build if two routes claim the
same words, as the TypeScript index does, so a bad table never becomes a binary.

## Tests

The existing TypeScript CLI process tests describe both implementations. With
`ACE_CLI_IMPL=rust` the shared helper (`apps/daemon/src/cli/pty-test-support.ts`) spawns
`native/cli/target/release/ace` instead of the TypeScript entry, and sets the hand-over
override, so the same file checks the binary. `ACE_CLI_BIN` picks another build.

```sh
ACE_CLI_IMPL=rust ACE_CLI_BIN="$PWD/native/cli/target/debug/ace" \
  bun --bun x vitest run apps/daemon/src/cli/grammar.process.test.ts --maxWorkers=4
ACE_CLI_IMPL=rust ACE_CLI_BIN="$PWD/native/cli/target/debug/ace" \
  bun --bun x vitest run apps/daemon/src/cli/agent-shell.process.test.ts --maxWorkers=4
```

Rust unit tests cover only what those files do not: release-version shapes, the release folder
in a binary's path, and `completion install`'s locations.

## Dependencies

Every dependency is listed with why it is needed and what it adds to the stripped release binary.
Sizes are `cargo bloat --release --crates` (`.text`, which excludes the 688 KiB binary's headers
and metadata); `cargo-bloat` inflates the file by keeping symbols, so measure size with `stat`.

| Crate | Why | Size added |
| ----- | --- | ---------- |
| `serde` 1.0 (`serde_core`) | `Serialize` for `help --json` and `help COMMAND --json`; `Deserialize` for the desktop app's version marker | 3.4 KiB, plus `serde_derive` at build time |
| `serde_json` 1.0 (`itoa`, `memchr`, `zmij`) | Compact and two-space JSON output; reading `desktop-app.json` | 24.6 KiB (+1.1 KiB `zmij`) |
| `strsim` 0.11 | Optimal string alignment distance for typo suggestions (`thraed` → `thread`) | 2.2 KiB |
| `ctrlc` 3.5 | Ctrl+C forwarding in the Windows hand-over only | 0 bytes on macOS and Linux; Windows only |

`serde` and `serde_json` are also `cli-table`'s build dependencies: the table is parsed once at
build time, never at run time. Nothing else is linked: no async runtime, no clap, no anyhow, no
regex. `native/cli/Cargo.lock` is checked in.

`cargo bloat --release --crates` on this build:

```
 File  .text     Size Crate
36.0%  81.9% 295.1KiB std
 9.1%  20.7%  74.4KiB ace
 3.0%   6.8%  24.6KiB serde_json
 0.9%   2.1%   7.5KiB cli_parse
 0.5%   1.2%   4.3KiB cli_out
 0.5%   1.1%   3.8KiB [Unknown]
 0.4%   1.0%   3.5KiB cli_table
 0.4%   0.9%   3.4KiB serde_core
 0.3%   0.6%   2.2KiB strsim
 0.1%   0.3%   1.1KiB zmij
44.0% 100.0% 360.2KiB .text section size
```

Stripped release binary: **704,976 bytes (688 KiB)**, against the 4 MB budget.

## Budgets

Measured by `bench/bench.sh` on a release build with `hyperfine --shell=none`, a temporary ace
home (no daemon) and no colour; medians of 300 runs. The machine is shared, so the per-run spread
is wide (p90 up to ~2.8 ms); the minimum is the floor with nothing else running.

| Run | Budget | Measured (median, min) | TypeScript from source (median) |
| --- | ------ | ---------------------- | ------------------------------- |
| `ace version` | under 3 ms | 2.30 ms (1.96 ms) | 121.4 ms |
| `ace help` | under 3 ms | 2.24 ms (1.81 ms) | 47.8 ms |
| `ace help thread` | under 3 ms | 2.24 ms (1.84 ms) | 46.1 ms |
| a usage error (`ace thraed list`) | — | 2.33 ms (1.90 ms) | 45.4 ms |
| `ace __complete`, daemon down | under 3 ms | 2.23 ms (1.80 ms) | 44.6 ms |
| hand-over | under 1 ms added | see below | — |
| stripped binary | under 4 MB | 0.67 MB | — |

The TypeScript column is the source CLI on Bun (`bun apps/daemon/src/cli.ts`), not the installed
bundle; the bundle on its bundled Node is slower still (ADR 0221 measured 232 ms for `version`),
and the hand-over bench below shows what that bundle's start costs here.

Hand-over, with an instant bundle so only process costs are left (medians of 150–300 runs):

| Run | Median |
| --- | ------ |
| Node running the bundle alone | 39.2 ms |
| a 300-byte Rust program that `exec`s the same Node and bundle | 44.2 ms |
| `ace` handing the same bundle over | 41.5–44.2 ms |
| `ace version` (the binary's own start, no exec) | 2.3 ms |

The binary's own start is 2.3 ms and macOS's `exec` of Node costs about the same again; the
hand-over code itself (finding the runtime, building the argument list, `exec`) is under the
measurement's noise floor, and the 300-byte wrapper pays the same total. The current `/bin/sh`
shim pays it too, so handing over is not slower than today's `ace` command.
