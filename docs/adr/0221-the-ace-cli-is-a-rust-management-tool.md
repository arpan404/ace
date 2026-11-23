# 0221: The ace CLI is a Rust tool for managing ace

Date: 2026-11-23. Status: accepted. Decided by: the owner (2026-11-23: "lets migrate cli", "we must
write optimised code and rust idiomatic", "ace cli is to manage devices, auth, settings, and other
triage and so on", chat through the CLI "was never the product decision so it must be removed").
Amends [ADR 0178](0178-one-cli-grammar-interactive-home-and-market.md): its decision 5 (`ace chat`
stays) and the attach and transcript parts of its interactive home. Keeps its grammar, help, output
and exit codes whole. Keeps [ADR 0092](0092-triage-and-doctor-repairs.md) (triage and doctor work
with ace broken) and [ADR 0072](0072-headless-cli.md) (the headless commands agents and scripts use).

## Context

`ace` is the daemon bundle run as a CLI: `~/.ace/bin/ace` runs `runtime/bin/node daemon/ace.mjs`.
Every command pays for starting Bun and loading the bundle (`ace version`: 232 ms), and the CLI
code (25k lines in `apps/daemon/src/cli`) ships inside the daemon.

ADR 0178 already made the CLI data-driven: the command table (`cli/commands/*.ts`) feeds the
parser, help, suggestions, completions and `ace help --json`, and every `--json` output has a
schema in `@ace/protocol/cli-outputs`. A second implementation can read the same table and be
held to the same schemas.

The owner also settled what the CLI is for. It manages ace: setup, sign-in, devices and pairing,
providers and accounts, settings, the daemon, storage, the Store and Spade bots, doctor and
triage. Talking to agents happens in the apps. A terminal chat may come back later as its own
product, only if it reaches the polish of the best terminal agents; it is not part of this work.

## Decision

### 1. Chat leaves the CLI

`ace thread attach` and its shortcut `ace chat`, `ace spade chat`, and the interactive home's
attach view, transcript, composer and new-thread flow are removed, with their tests and docs.
The headless commands agents and scripts use stay: `ace run` (`thread start`), `thread send`,
`thread steer`, `thread approve`, `wait` and the rest of ADR 0072. The bare `ace` home stays as
a management home: what runs, what needs the person, and the start, doctor and triage keys.

### 2. One Rust binary in front, the bundle behind it

`native/cli` is a Cargo workspace (pinned toolchain, licence allowlist and lints of
`native/history`) that builds one binary, `ace` (`ace.exe`). It runs a command itself when that
command is ported; otherwise it hands the unchanged argument list to the bundled runtime
(`node ace.mjs`): `exec` on macOS and Linux, a child with the same stdio, exit code and Ctrl+C on
Windows. Every release is therefore whole while commands move one group at a time. `ace start`,
`ace serve` and `ace daemon start` always hand over: they run the daemon.

The binary finds the runtime and bundle next to itself, in each shipped layout (the desktop app's
`Resources`, a release's `bin/`), never through PATH. `~/.ace/bin/ace` points at the binary once a
release ships it, and at the old shim when the binary is missing.

### 3. One command table

The TypeScript table stays the source until the last command moves. `bun run cli:table` writes it
to `native/cli/table.json` (checked in; `check:cli` fails when stale), and a build script turns it
into static Rust data: no JSON is parsed at run time. Each Rust command marks itself ported in
code; `check:cli` refuses a command marked ported that the table doesn't list.

### 4. The same outputs, proven

A ported command prints what the TypeScript one printed: the same `--json` value, the same human
text, stderr and exit code. The proof is the existing CLI tests run against the Rust binary
(see Tests). Differences are bugs in the port unless this ADR's amendments list them.

### 5. Fast by construction

Budgets, measured with `hyperfine` on release builds by `native/cli/bench` and kept in its README:

| Run                                          | Budget                                     |
| -------------------------------------------- | ------------------------------------------ |
| `ace version`, `ace help`, `ace help thread` | under 3 ms                                 |
| a completion request with the daemon down    | under 3 ms                                 |
| `ace status --json` with the daemon up       | under 15 ms plus the daemon's own time     |
| handing over to the bundle                   | under 1 ms added to the bundle's own start |
| stripped binary                              | under 4 MB                                 |

How:

- No async runtime. One blocking connection per run, with deadlines (`set_read_timeout`), is all
  a CLI needs. No tokio or other async runtime (so no hyper or reqwest), no clap (the parser
  follows ace's own command table), no anyhow.
- Nothing runs before the line is parsed. Help, version and completion touch only the static table.
- `--json` output the daemon already shaped is written as it arrived (`serde_json::value::RawValue`),
  not decoded and re-encoded. Human output decodes only the fields it prints, borrowing from the
  reply buffer (`#[serde(borrow)]`, `&str`, `Cow`).
- One locked, buffered stdout writer per run, flushed once; one reply buffer reused per connection.
- Release profile: `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`,
  `opt-level = 3`.
- Standard work uses well-established, efficient crates rather than code written by hand (the
  owner, 2026-11-23): `serde` and `serde_json`, `ureq` (blocking, rustls with ring) for HTTP and
  pinned remote machines, `tungstenite` (blocking) for the daemon socket, `strsim` for
  suggestions, `crossterm` for the interactive home and prompts. Every dependency is listed in
  `native/cli/README.md` with why it is needed and what it adds to the binary.

### 6. Idiomatic Rust

- **Pure core, thin shell**, as everywhere in ace: parsing, alias rules, output shaping, exit codes
  and rendering are pure functions over data. Sockets, files, env, clock and terminal are passed in
  (a small trait or a parameter), so tests run without a daemon or a TTY.
- Errors are typed enums implementing `std::error::Error`, mapped to the CLI's failure envelope and
  exit codes in one place. No `unwrap`, `expect`, `panic!` or `unsafe` outside tests (workspace
  lints deny them; `clippy::pedantic` and `clippy::perf` are denied with a short, commented allow
  list).
- Borrow before cloning; iterators over index loops; newtypes for ids (`ThreadId`, `RequestId`);
  exhaustive `match` on enums, never a catch-all over ace's own variants.
- Modules stay under 400 lines; the repository's 1,500-line hard limit applies.
- Unknown fields and variants in daemon replies are kept or ignored, never fatal (AGENTS.md).

### 7. Order

1. Remove chat from the TypeScript CLI (§1).
2. Core: the workspace, table export, parser with alias, deprecation and suggestion rules, output
   and failure envelope, hand-over, and the offline commands (help, version, completion).
3. Daemon connection: endpoint and token reading with the TCP probe and `daemon_down` (exit 4),
   the WebSocket request client and the `/v1/*` HTTP calls, machine profiles with pinned TLS.
4. Commands by group: machine and daemon; providers and accounts; work (headless only); Store,
   Spade and bots (the bot kit's `init/check/test/dev`, which run JS, keep handing over);
   agent tools.
5. Shipping: release layouts, the `~/.ace/bin/ace` shim, desktop and installers, on every platform.
6. The management home and setup flows in Rust, with prompts, pickers and progress at the polish
   of the best terminal tools: inline rendering, no flicker, instant keys.
7. Doctor and triage last: they must work with ace broken, so they move only once the Rust binary
   ships everywhere the bundle does.

The TypeScript CLI is deleted command group by command group as each Rust group ships.

## Consequences

- Most commands start in milliseconds and need no JS runtime; scripts and completions get faster.
- Two implementations exist during the move; the existing CLI tests, run on both, and `check:cli` keep them equal.
- People who used `ace chat` or `ace spade chat` use the apps. The removed commands answer with a
  usage error naming the app (exit 2) for one release, then disappear.
- The CLI's code leaves the daemon bundle group by group, shrinking it.

## Tests

Tests move; they don't multiply (the owner, 2026-11-23: ace has too many tests).

- The existing TypeScript CLI tests are the proof. Their helpers take a switch that runs the Rust
  binary instead of the TypeScript entry, and every test that drives the CLI through argv,
  stdout, stderr and exit code must pass on Rust before a group ships. Tests of private
  TypeScript helpers are not run against Rust; the behaviour they guard is checked through a test
  that drives the CLI.
- When a TypeScript group is deleted, its behaviour tests move to Rust then, as unit tests of the
  pure core. No second suite exists alongside the first.
- New Rust tests only for behaviour no existing test covers, input to output, never structure.
- The bench is a tool, not a test, and runs in no test tier.
