# ace-cli

The `ace` command-line tool, in Rust ([ADR 0221](../../docs/adr/0221-the-ace-cli-is-a-rust-management-tool.md)).
It runs ported commands itself and hands every other command to the bundled runtime.

```sh
bun run cli:table         # regenerate native/cli/table.json from the TypeScript table
bun run check:cli         # table freshness, fmt, clippy, tests, licences, and the CLI process tests
native/cli/bench/bench.sh # hyperfine against the TypeScript CLI, and the §5 budgets
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
- `ace __complete` (including with no words typed), as long as the word being completed does
  not name a live reference
- bare `ace` off a terminal: the overview

Runs natively through the daemon connection (ADR 0221 step 4, providers group):

- `ace provider list|show|capabilities`, `ace model list`
- `ace account status|logout`, `ace account machine-code clear`
- `ace machine list`
- `ace device list|revoke`
- `ace remote list|use|remove`
- `ace mcp list|add|revoke`

Hands over: every other command, and these cases even for the commands above:

- `--jq` anywhere (the filter is jq's to compile and run)
- `help --schema` (the schemas are Zod, in the bundle)
- an old spelling (`parsed.alias`), so its notice or refusal is printed once, by the bundle
- an unported command whose arguments are missing, before the native missing-argument error:
  the bundle decides what they mean (a person-only action refuses before it ever asks for one)
- a missing required argument on a terminal (the bundle asks for it)
- a completion slot that names a live reference (thread, project, request, bot): the daemon
  connection lands in ADR 0221 step 3, then these answer here too
- the interactive home, when a person is at a terminal
- the providers group's interactive sign-in and pairing flows: `provider login`, the
  `provider account` registry, `account login`, `account machine-code set`, `device pair`,
  `remote add` and `mcp request` (their prompts, QR codes, device codes, browser polling and
  the `@ace/accounts` registry stay in the bundle until the Rust side matches them exactly)

`ace status --json` and every other daemon command still hand over, so ADR 0221 §5's
"under 15 ms plus the daemon's own time" budget is for step 3, not this one.

Hand-over finds the runtime and `ace.mjs` beside the binary, in each shipped layout:

- a release: `<release>/bin/ace`, `<release>/bin/node`, `<release>/ace.mjs`
- the desktop app: `…/Resources/bin/ace`, `…/Resources/runtime/bin/node`,
  `…/Resources/daemon/ace.mjs` (`node.exe` on Windows)
- the published npm package: `<package>/bin/ace`, `<package>/runtime/bin/node`,
  `<package>/runtime/ace.mjs`

When one file is there and the other is not, the failure names the missing one and where it
belongs: "the runtime it runs commands with" or "the bundle it runs commands from".

It runs `node --disable-warning=ExperimentalWarning ace.mjs ARGS…`, the same flag the current
shim passes: `exec` on Unix (arguments, stdio, signals and exit code are the child's), and on
Windows a child with inherited stdio whose exit code ends the process. The Ctrl+C handler is
registered before the spawn, so an interrupt during startup is not lost, and the child (which
shares the console) handles the event itself; a failed registration or wait is reported, never
dropped. `ACE_CLI_NODE` and `ACE_CLI_ENTRY` override both paths for development and tests only;
both must be set, and both must be absolute, so a bare `ACE_CLI_NODE=node` never searches PATH.

Arguments reach the bundle as the `OsString`s the process received, byte for byte; the parser
only sees their UTF-8 view. A hand-over never makes a writer.

## The table

`bun run cli:table` writes `native/cli/table.json` from the TypeScript table
(`commandTable()`, global flags, nouns, topics, exit codes). It is checked in;
`check:cli` fails when it is stale. `cli-table/build.rs` fails the build if two routes claim the
same words, as the TypeScript index does, so a bad table never becomes a binary. A Rust unit test
fails when a natively dispatched id leaves the table.

## Tests

The existing TypeScript CLI process tests describe both implementations. With
`ACE_CLI_IMPL=rust` the shared helper (`apps/daemon/src/cli/pty-test-support.ts`) spawns the
Rust binary instead of the TypeScript entry and sets the hand-over override, so the same file
checks both. `ACE_CLI_BIN` picks another build. `check:cli` builds the debug binary and runs
both files this way.

```sh
ACE_CLI_IMPL=rust ACE_CLI_BIN="$PWD/native/cli/target/debug/ace" \
  bun --bun x vitest run apps/daemon/src/cli/grammar.process.test.ts --maxWorkers=4
ACE_CLI_IMPL=rust ACE_CLI_BIN="$PWD/native/cli/target/debug/ace" \
  bun --bun x vitest run apps/daemon/src/cli/agent-shell.process.test.ts --maxWorkers=4
```

Rust unit tests cover only what those files do not: release-version shapes, the release and
desktop folders in a binary's path, `completion install`'s locations, and the native ids being
in the table.

## Dependencies

Every dependency is listed with why it is needed and what it adds to the stripped release binary.
Sizes are `cargo bloat --release --crates` (`.text`, which excludes the binary's headers and
metadata); `cargo-bloat` keeps symbols and so inflates the file, so measure size with `wc -c`.

| Crate | Why | Size added |
| ----- | --- | ---------- |
| `serde` 1.0 (`serde_core`) | `Serialize` for `help --json` and `help COMMAND --json`; `Deserialize` for the desktop app's version marker | 3.4 KiB, plus `serde_derive` at build time |
| `serde_json` 1.0 (`itoa`, `memchr`, `zmij`) | Compact and two-space JSON output; reading `desktop-app.json` | 24.6 KiB (+1.1 KiB `zmij`) |
| `strsim` 0.11 | Optimal string alignment distance for typo suggestions (`thraed` → `thread`) | 2.2 KiB |
| `ctrlc` 3.5 | Ctrl+C handling in the Windows hand-over only | 0 bytes on macOS and Linux; Windows only |
| `rusqlite` 0.41 (`bundled`, no default features) | The CLI profile store (`cli-profiles.sqlite`): remote profiles and the selected profile, read the way the TypeScript CLI reads them | ~1.4 MiB, almost all of it the SQLite C amalgamation (`libsqlite3_sys` counts 98.6 KiB of Rust glue and 9.3 KiB of `rusqlite` itself) |

`serde` and `serde_json` are also `cli-table`'s build dependencies: the table is parsed once at
build time, never at run time. `serde_json`'s `raw_value` feature (no new crate) lets `--json`
output the daemon already shaped pass through untouched, and `preserve_order` keeps a locally
built object's keys in the order the TypeScript CLI writes them (`indexmap` itself: 1.1 KiB).
No async runtime, no clap, no anyhow, no regex. The OS home lookup for `completion install` is
`std::env::home_dir`, not a crate. `native/cli/Cargo.lock` is checked in.

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

Stripped release binary: **721,616 bytes (704 KiB)**, against the 4 MB budget.

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
| `security-framework` / `schannel` | target-gated (`macos` / `windows`) | Lazy OS system CA roots for `.ts.net` renewal fallback (ADR 0097) without reading `SSL_CERT_FILE` / `SSL_CERT_DIR` (Linux reads fixed `/etc/ssl/...` bundle paths via `rustls` PEM parser) | `+17.8 KiB` (macOS `Security.framework` bindings; `0` on Linux) |

With the providers group (`ace provider|model|account|machine|device|remote|mcp`, step 4) the
stripped release binary is **4,307,792 bytes (4.11 MiB)** on `aarch64-apple-darwin`, over the
4 MiB budget: the SQLite C amalgamation (`rusqlite` bundled, for `cli-profiles.sqlite`) alone
accounts for about 1.4 MiB of it, which the budget predates. Nothing else in the group moves
the number materially.

## Budgets

Measured by `bench/bench.sh` on a release build with `hyperfine --shell=none`, a temporary ace
home (no daemon) and no colour; medians, which the script checks against the budgets. The machine
is shared, so single runs spread wide; the medians below hold run after run.

| Run | Budget | Measured | TypeScript from source |
| --- | ------ | -------- | ---------------------- |
| `ace version` | under 3 ms | 2.02 ms | 102.7 ms |
| `ace help` | under 3 ms | 2.17 ms | 36.3 ms |
| `ace help thread` | under 3 ms | 2.36 ms | 40.5 ms |
| a usage error (`ace thraed list`) | — | 2.32 ms | 40.3 ms |
| `ace __complete`, daemon down | under 3 ms | 2.30 ms | 39.1 ms |
| `ace --json` (management tree) | — | 2.52 ms | — |
| stripped binary | under 4 MB | 0.69 MB | — |

The TypeScript column is the source CLI on Bun (`bun apps/daemon/src/cli.ts`), not the installed
bundle; the bundle on its bundled Node is slower still (ADR 0221 measured 232 ms for `version`).

Hand-over, with a bundle that exits at once so only process costs are left (medians):

| Run | Median |
| --- | ------ |
| Node running the bundle alone | 35.7 ms |
| `ace` handing the same bundle over | 42.9 ms |
| `ace version` (the binary's own start, no exec) | 2.2 ms |

The binary's start is 2.2 ms. macOS's `exec` of Node accounts for the remaining ~5 ms: in the same
session a 300-byte Rust program that only `exec`s the same Node and bundle measured 44.2 ms
against Node's 39.2 ms. The hand-over code itself (finding the runtime, building the argument
list, `exec`) is under the measurement's noise floor, and today's `/bin/sh` shim pays the same OS
exec. ADR 0221 §5's "under 1 ms added" is therefore honest only for ace's own work before `exec`;
the end-to-end number a person sees is the binary's start plus the OS's exec. The bench prints
the medians so a proposed budget ("under 8 ms added to the bundle's own start", with ace's own
work under 1 ms) can be checked rather than assumed; it enforces the 3 ms runs and the 4 MB size,
which are within ace's control.
