# 0225: Devices, screens, automations and the MCP server stay TypeScript; Rust takes the work that measures

Date: 2026-11-23. Status: proposed (draft for the owner). Decided by: pending the owner.

## Context

The owner is moving the daemon to Rust: the CLI ([ADR 0221](0221-the-ace-cli-is-a-rust-management-tool.md)),
the store ([ADR 0222](0222-the-event-store-moves-to-rust-behind-the-same-store.md)) and the
engine and adapters ([ADR 0223](0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md))
are done or under way on `ace/daemon-rust-rewrite`. The next areas named are `@ace/devices`,
`@ace/screen`, `@ace/automations` with the daemon's automation executor and monitor, and
`@ace/mcp-server`. Their contracts and every test file's class are in
[docs/devices/behaviour.md](../devices/behaviour.md),
[docs/screen/behaviour.md](../screen/behaviour.md),
[docs/automations/behaviour.md](../automations/behaviour.md) and
[docs/mcp-server/behaviour.md](../mcp-server/behaviour.md).

ADR 0222's "Measured after building" section set the rules this one follows: a Rust port that
must reproduce JavaScript- and Zod-shaped output diverges again and again, so such output stays
TypeScript or goes through `ace-json`; a Rust path that returns JSON for JavaScript to parse again
can be slower than the TypeScript; the existing TypeScript tests are the proof; and time is
measured before anything is designed.

### What there is

| Area                                                   | Source lines  | Modules | Test files (a / b / c, with daemon tests)               |
| ------------------------------------------------------ | ------------- | ------- | ------------------------------------------------------- |
| `@ace/devices`                                         | 18,462        | 124     | 46 / 41 / 0                                             |
| `@ace/screen`                                          | 14,516        | 98      | 62 / 30 / 0                                             |
| `@ace/automations` + `apps/daemon/src/automation-*.ts` | 3,504 + 2,452 | 23 + 11 | 34 / 8 / 0                                              |
| `@ace/mcp-server`                                      | 8,947         | 66      | 52 / 6 / 0 (21 outside-endpoint files not in this move) |

Already native: the macOS screen helper (Swift), the Linux and Windows screen helpers (Rust),
the locked-use service, and ace-media (Rust, its own processes), which since
[ADR 0208](0208-ace-media-is-the-only-media-and-image-pipeline.md) does all encoding, delivery,
recording, stills and image work. No TypeScript decodes or encodes a pixel.

### Measurements

Taken 2026-11-23 on an M4 Max shared with other builds (load average 50 to 140), Bun 1.4.4, with
the packages' own benches and fakes and a daemon started in process on an empty temporary home
(`HOME` and `ACE_HOME` both temporary; no provider, real simulator, device, screen or app was
used, and no quota spent). Times are noisy; counts and shares are not.

| What                                                                                           | Measured                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP: registry dispatch / HTTP round trip through the SDK (`bench/dispatch.ts`)                 | 2.4 µs / 171–224 µs                                                                                                                             |
| MCP: real daemon, 50 tools: `tools/list` (53 KB) / core listing (11 KB) / `tools/call context` | p50 0.57–1.36 ms / 0.17–0.30 ms / 0.65–1.03 ms                                                                                                  |
| MCP: CPU profile of 7,500 daemon requests (`bun --cpu-prof-md`)                                | daemon store work around each call about 55% (recording the call 23–25%, change digest 12%, availability 6%); Zod about 8%; SDK and HTTP 10–15% |
| Computer use: real toolkit and client over fake helper processes                               | 120–251 µs of daemon CPU per call; 2 helper processes for 600 calls                                                                             |
| Computer use: Zod check of a 256-node helper reply / 1 MiB image result                        | 163 µs / 479 µs                                                                                                                                 |
| Devices: `sim_list` / `sim_ui` (120 nodes) / `sim_act` on a ref / at a point                   | 78 / 636 / 474 / 51 µs of CPU per call                                                                                                          |
| Frames in JavaScript: 128 KiB framing / picture assembly / fan-out                             | 4.7–5.3 µs / 4.2 µs / 0.09–0.27 µs                                                                                                              |
| A supervised spawn of `/usr/bin/true` (daemon CPU)                                             | 1.25 ms (0.28 ms for a bare `spawnSync`)                                                                                                        |
| Device inventory while a view watches it                                                       | 3 SDK commands every 4 s (`simctl list`, `emulator -list-avds`, `adb devices -l`); none otherwise                                               |
| Android video through JavaScript                                                               | every H.264 unit crosses the JS thread twice (scrcpy socket → ingest, egress back); iOS once (egress)                                           |
| Automations: next occurrence / indexed next deadline / durable admission                       | 11–18 µs / 14 µs / 232–449 µs                                                                                                                   |
| Automations: one supervised `gh` call / a 1,000-PR poll with 8 KB bodies                       | 42 ms / 53–432 ms (1 to 1,000 changes)                                                                                                          |
| Automation run monitor                                                                         | an indexed read of the run's turn every 5 s per active run                                                                                      |

Calls arrive at the rate models make them, seconds apart per agent; a helper's UI settle or a
simulator command takes tens to hundreds of milliseconds; a poll runs at most once a minute.

## Decision

### 1. What gains from Rust, and what doesn't

| Part                                                                    | Gain from Rust                                                                                                                                                                                                 | Decision                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| MCP transport (SDK, HTTP, SSE, sessions)                                | at most 0.1–0.2 ms of a call made seconds apart                                                                                                                                                                | stays TypeScript                                         |
| MCP registry, Zod validation, listings, error text                      | none; the output is Zod- and JavaScript-shaped (schemas from `z.toJSONSchema`, argument-issue text, about 80 fixed public errors)                                                                              | stays TypeScript                                         |
| Store work around each MCP call (55% of its CPU)                        | none from moving the server; it is store reads and writes, cheaper by doing fewer of them                                                                                                                      | a TypeScript change, outside this ADR (question 2)       |
| Tools whose owners move to Rust (agent-control, ADR 0222's path step 2) | they stop crossing into JavaScript for their work                                                                                                                                                              | **M1**: native tool entries in the TypeScript registry   |
| Computer use and screen sessions                                        | none: 0.12–0.25 ms per call beside a native helper that takes far longer                                                                                                                                       | stays TypeScript                                         |
| Device control plane (leases, cowork, refs, tools, bridge)              | none: 28–636 µs per call beside SDK commands                                                                                                                                                                   | stays TypeScript                                         |
| Android video through the JS thread                                     | the video path stops depending on the JS thread (a main-thread stall, up to 146 ms per commit in ADR 0222's measurement, stalls Android video today; iOS is already read by ace-media)                         | **D1**: ace-media reads scrcpy's video socket itself     |
| SDK and `gh` spawns (1.25 ms of daemon CPU each)                        | the supervisor's share, through ADR 0223 E2 (`ACE_SUPERVISOR=native`), with no change here                                                                                                                     | inherited                                                |
| Inventory polling                                                       | none from the language; `adb` can push changes instead                                                                                                                                                         | a TypeScript change, outside this ADR (question 3)       |
| Automation scheduler (recurrence, admission, store, webhooks)           | none: microseconds per decision, one timer; and `compileSchedule` also runs in `ui-core` and `fake-daemon`                                                                                                     | stays TypeScript                                         |
| Automation executor and run monitor                                     | they read engine and thread-tree state; once the engine is Rust, reading it from Rust avoids a JSON round trip per check, and the rules that decide a run is over (priority 1) live beside the state they read | **A1**: after the engine, as a Rust `AutomationExecutor` |

Plainly: none of the four areas is slow because it is TypeScript. Pixels, codecs, capture,
accessibility and input are native already; what is left is control logic whose cost is
microseconds against work that takes milliseconds to seconds, and whose output is
JavaScript-shaped. A literal port would carry the divergence risk ADR 0222 measured for no
measured gain. Three narrow moves have a reason: D1, M1 and A1.

### 2. Where the Rust code goes

- **In process, in `native/daemon`** (the napi-rs addon of ADR 0222): M1 and A1. Both act inside
  the store's transactions and the engine's state, so the one-connection, one-SQLite-library rule
  of ADR 0222 §1 and §3 applies, and a second process could not join those transactions.
- **In an existing native helper**: D1 goes into ace-media, which already reads serve-sim's stream
  itself (`native/media/crates/ace-media/src/serve_sim.rs`) and already has a `scrcpy {host,
port}` origin in its wire (`media-wire/src/control.rs:130`). No new process.
- **No new sidecar.** A Rust devices or screen process was weighed and rejected: every request from
  the socket bridges and the JavaScript toolkits would cross a process; leases, cowork and
  agent ownership are decided against engine state in the daemon; it adds a crash domain; and
  nothing measured asks for it. Merging the screen helpers was rejected too: each is the native
  code its OS needs (AX on macOS, AT-SPI and portals on Linux, UIA on Windows), and the
  TypeScript over them is the shared part.

### 3. Crates

- **`rmcp` for the daemon's server: not now.** The tools are JavaScript, so a Rust server would
  bridge every call back; the transport it would replace is 10–15% of a call; and it would have
  to reproduce what the SDK does today (2026-07-28 and legacy 2025 sessions, SSE notification
  streams with per-lease bounds, `list_changed`, mirrored-header validation of `x-mcp-header`
  parameters, the outside endpoint's resource binding). It becomes the choice when no JavaScript
  tool handler is left, which needs its own ADR. `rmcp` stays in use as the Pi adapter's MCP
  client (ADR 0223 §2).
- **`tokio-cron-scheduler`: rejected for A1 and for the scheduler.** It keeps jobs in memory with
  its own persistence model and standard cron semantics (an autumn fold runs twice), against ADR
  0015's (once, at the first instant). ace's scheduler is one timer armed for the earliest
  deadline the store's index returns (`store.ts:314`): a query and a timer, not a crate. A1 moves
  no scheduling.
- **D1**: ace-media's own crates (`media-wire`, `media-ingest`, the shell's reader threads); the
  scrcpy video framing is twelve-byte packet headers over a TCP stream, written beside
  `serve_sim.rs` as its pure half, with the vectors in `native/media/vectors`.
- **M1 and A1**: `napi` 3 (through `ace-daemon-node`), `ace-json` for every value that crosses
  (ADR 0223 porting guide rule 8), `ace-store`, `ace-engine`, `thiserror`. Nothing else.

### 4. The boundary, and how output stays what TypeScript produces

The rule from ADR 0222: Rust fetches and decides; TypeScript shapes what a model, a person or a
client reads.

- **M1, native tools.** A native tool is registered in the same `ToolRegistry` with the same Zod
  input and output schemas, title, risk class and timeout, so its descriptor, annotations and
  `tools/list` entry are built by the same TypeScript code. A call is admitted, budgeted, parsed
  and timed by `ToolRegistry.call` exactly as today; the parsed input crosses to Rust as
  `ace-json`; Rust returns either a structured value or a `PublicToolCode` (with its detail
  fields); TypeScript runs the output schema, `JSON.stringify` and `PublicToolError` as it does for
  every tool. Text the model reads is never produced in Rust. Cancellation: the call's
  `AbortSignal` becomes a cancellation token the Rust task checks; a Rust tool that ignores it
  keeps its slot, as a JavaScript one does.
- **A1, the automation executor.** The boundary is `AutomationExecutor` (`contracts.ts:32`): the
  TypeScript `AutomationService` calls `execute`, `recover` and `interrupt` as today, and with the
  switch on they reach a Rust implementation that sends the run's command through the native
  engine, follows its turn and tree with the same rules (`automation-run-rules.ts`, ported rule
  for rule, in order) and resolves `{threadId, status, result}`. `ExecutionResult` is still parsed
  by its Zod schema in TypeScript; the run's `result` text is read from the thread in Rust and
  returned untouched. The run records (`automation-run-record.ts`) keep their table and columns.
- **D1, Android video.** The boundary is ace-media's control wire: the daemon opens the source
  with the `scrcpy` origin and the forwarded port, keeps scrcpy-server, its control socket, the
  capture's lifecycle and every decision about who watches; ace-media connects the video socket
  first (scrcpy-server accepts its tunnel's connections in order: video, then control), reports
  that it is connected, and the daemon then connects control. Egress hands units back exactly as
  it does for a Simulator, so the capture downstream sees the same `VideoUnit`s, numbered as
  before.

### 5. Switches

Read once at the I/O boundary by the switch module ADR 0223 E0 created
(`packages/provider-kit/src/native-switches.ts`); unset is today's TypeScript; set without its
native part, the daemon refuses to start and says so.

| Switch                                 | Phase | Needs                                           |
| -------------------------------------- | ----- | ----------------------------------------------- |
| `ACE_SCRCPY_VIDEO=media`               | D1    | an ace-media build with the scrcpy reader       |
| `ACE_NATIVE_TOOLS=<family>[,<family>]` | M1    | `ACE_STORE=native`; the family's owner in Rust  |
| `ACE_AUTOMATION_EXECUTOR=native`       | A1    | `ACE_ENGINE=native` (and so `ACE_STORE=native`) |

`ACE_NATIVE_CROSS` (ADR 0223 §8) learns `ACE_AUTOMATION_EXECUTOR` and `ACE_NATIVE_TOOLS`: both
leave rows (run records, call records) that the other backend must read after a restart.

### 6. Phases, each shippable alone

| Phase | What moves                                                                                                                              | Switch                           | Proven by                                                                                                                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1    | ace-media reads an Android device's scrcpy video socket; the daemon stops forwarding units                                              | `ACE_SCRCPY_VIDEO=media`         | devices (a): `scrcpy-capture.process`, `scrcpy-media.process`, `live-view.process`, `capture.process`, `platform.process`, `android-physical.process`; (b) moved to `cargo test`: `scrcpy-protocol`, `scrcpy-video` cases; ace-media's vectors                                                                                                                        |
| M1    | the registration kind for native tools, then each family whose owner has moved (first: agent-control's tools, when agent-control moves) | `ACE_NATIVE_TOOLS=<family>`      | mcp-server (a): all 36; daemon MCP (a): all 16 with the family on; that family's own (a) files                                                                                                                                                                                                                                                                        |
| A1    | `AutomationExecutor` in Rust: run commands, the monitor, the run rules and records                                                      | `ACE_AUTOMATION_EXECUTOR=native` | automations (a): all 25 (they use executor fakes, so they prove the service is untouched); daemon (a): the 9 automation process files; (b) moved: `automation-run-rules` cases; cross-mode: those of the 9 that restart a daemon (`automation-durability.process` and `automation-run-record.process` first; `scripts/native-cross.ts` drops any that never restarts) |

Order: D1 needs nothing and can go now. M1 waits for the first tool family whose owner is Rust;
its registration kind is built then, not before, so it is proven by a real family. A1 waits for
ADR 0223 E5 to be default-on, since the executor's work is engine reads.

Each phase is off by default until its (a) files pass alone with the switch on and off on macOS,
Linux and Windows (D1: macOS and Linux, where Android devices are used; the Windows VM for the
`adb` path), its cross-mode list passes both ways (M1, A1), and its bench is no worse: D1
`packages/devices/bench/emulator-video.ts` is owner-run on a real emulator (fps and stalls,
switch off and on) because nothing synthetic measures a stall; M1 the in-process daemon request
measurement in §Context (`tools/call` p50 and CPU per call); A1
`packages/automations/bench/lifecycle.ts` and `apps/daemon/bench/agent-control.ts`.

What does not move in this plan: the device control plane, `@ace/screen`, the automation
scheduler and the MCP transport and registry. Reopening that needs a measurement that shows a
cost the language causes, or the end of JavaScript tool handlers (for the server).

### 7. Tests move, they don't multiply

No new tests and no parity harness. The (a) files named above run unchanged with each switch on;
the (b) cases of a module that is replaced move into `#[cfg(test)]` beside the Rust function that
replaces it; the TypeScript test is deleted only when its module is, after default-on. The live
files (marked † in the behaviour documents) are run by the owner only.

## Consequences

- Most of the code named for the move stays TypeScript. The daemon keeps a TypeScript shell around
  its Rust core for longer: the socket bridges, the toolkits and the MCP server.
- Android live views stop depending on the daemon's JavaScript thread, as iOS views already do.
  ace-media holds one more kind of connection (an `adb`-forwarded localhost TCP socket).
- When agent-control moves, its tools reach Rust without leaving the MCP contract: same listing,
  same annotations, same error text, same budgets.
- Automation runs are judged over by Rust code reading Rust state once the engine is Rust; the
  rule order of `automation-run-rules.ts` is ported as it is (priority 1: a run is never succeeded
  while any part of its tree works or waits on the person).
- The two largest measured costs found here are not Rust questions: the store work around every
  MCP call and the inventory's SDK spawns. They are left to the owner (questions 2 and 3).

## Questions for the owner

1. **Stay TypeScript.** Accept that the device control plane, `@ace/screen`, the automation
   scheduler and the MCP transport and registry stay TypeScript, with D1, M1 and A1 the only Rust
   work in these areas? The alternative, a literal port, has no measured gain and the divergence
   risk ADR 0222 recorded.
2. **The store work around each MCP call** (about 55% of a call's CPU: two write transactions to
   record the call, `tool-result-mcp.ts:199`–`:263`, and a full read of the session's facts for the
   digest, `awareness.ts:118`). Fix it in TypeScript now (one write per call, facts invalidated by
   events instead of read per call), or leave it for the store's writer phase?
3. **Inventory without polling**: `adb track-devices` over the adb server's socket and a watch on
   the AVD directory would leave only `simctl list` on the 4 s poll. Worth a TypeScript change?
4. **D1's connection order**: ace-media connects scrcpy's video socket before the daemon connects
   control. Accept ace-media holding that socket, or keep the forwarding (and the JS-thread
   dependency) until a measured stall says otherwise?
5. **A1's timing**: after ADR 0223 E5 is default-on (recommended), or earlier through the
   TypeScript `Engine` facade (which gains nothing, since its reads would cross back into
   JavaScript)?
6. **If the scheduler ever moves**: its zone rules come from the runtime's ICU through `Intl`; a
   Rust scheduler would read the system's zoneinfo (or a bundled copy) and could disagree at a
   tzdata update. Accept that, or never move the scheduler (recommended, since `ui-core` and
   `fake-daemon` need it in JavaScript anyway)?
7. **The MCP server's end state**: move it to `rmcp` once no tool handler is JavaScript (a later
   ADR), or keep the SDK for as long as the official TypeScript SDK leads the specification?
