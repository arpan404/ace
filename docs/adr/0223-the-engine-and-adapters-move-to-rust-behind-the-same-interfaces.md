# 0223: The engine and provider adapters move to Rust behind the same interfaces

Date: 2026-11-23. Status: proposed (draft for the owner). Decided by: pending the owner.

## Context

The owner has decided (2026-11-23) to move the daemon's core to Rust in this order: the event
store ([ADR 0222](0222-the-event-store-moves-to-rust-behind-the-same-store.md), in progress on
`ace/rust-store`), then the engine and the provider adapters, then agent-control, then machines.
ADR 0222's "Path after the store" sketches the end state: one Rust core in `native/daemon`, a
napi-rs addon Bun loads in process, growing phase by phase while the TypeScript shell shrinks,
with the existing TypeScript tests running through the same TypeScript interfaces at every step.

The engine's contract is in [docs/engine/behaviour.md](../engine/behaviour.md). This ADR decides
how it and the six adapters move.

### What there is to move

Counted on `ace/rust-store` b359519ad3:

| Part                                                          | Source lines                                   | Modules                      | Test files                  |
| ------------------------------------------------------------- | ---------------------------------------------- | ---------------------------- | --------------------------- |
| `apps/daemon/src/engine`                                      | 21,619                                         | 136                          | 173                         |
| `@ace/core` (fact reducer, status rules)                      | 4,943                                          | 40                           | 40                          |
| `@ace/provider-kit` (processes, streams, JSON-RPC, discovery) | 11,623                                         | 111                          | 82                          |
| `@ace/engine-api` (the adapter interface)                     | 333                                            | 1                            | 0                           |
| adapters: Codex, Cursor, OpenCode, Claude, ACP, Pi            | 10,356 / 7,251 / 7,039 / 6,054 / 6,011 / 3,438 | 156 / 62 / 61 / 54 / 44 / 29 | 61 / 48 / 41 / 50 / 35 / 20 |

Of the 555 test files, 426 test behaviour through a public interface (class a), 72 test TypeScript
internals (b), one is structural (c), and 56 cover code that stays TypeScript (behaviour.md §19).

### Facts the design must respect

1. **The engine is already a pure core with an I/O shell.** Adapters translate frames into facts
   with pure, synchronous translators (`Translator`, `engine-api/src/index.ts:110`); `@ace/core`
   folds facts into events and statuses with no I/O (`core/src/reduce.ts:45`); the engine around
   them owns mailboxes, intents, sessions and recovery. Every port the engine can't control (clock,
   ids, adapters, workspace preparation, models, MCP, transitions) is injected through
   `EngineOptions` (`engine/engine-options.ts:14`), and the 173 engine test files inject fakes
   there: `ManualClock` (`engine/test-support.ts:24`) and scripted adapters
   (`@ace/adapter-testkit`).
2. **The engine runs inside the store's synchronous transactions.** Command admission is one
   `store.atomic` that also runs the receipt (`engine/index.ts:410`); a frame batch's events,
   thread state and engine records commit in one transaction (`engine/repository.ts:294`, `:413`).
   614 other call sites in 176 daemon files share that connection synchronously
   (ADR 0222, constraint 1).
3. **The engine's async code is an interleaving of awaits and generation checks.** Session
   callbacks check `generation === actor.generation && !lifetime.signal.aborted` after every await
   (`engine/sessions.ts:523`–`:711`); delivery claims in a transaction, awaits the provider, then
   decides by what was acknowledged meanwhile (`engine/intent-delivery.ts:63`–`:140`). The tests
   pin these races (`steer-race`, `clock-rollback`, `recovery-opening-restart`, `stop-escalation`).
4. **Two provider libraries are JavaScript and must stay so.** Cursor's `@cursor/sdk` already runs
   in a host child process that ace talks to over JSON-RPC on stdio (`adapter-cursor/src/host.ts:96`,
   `host-entry.ts`). Claude's `@anthropic-ai/claude-agent-sdk` runs inside the daemon, with ace's own
   spawn of the `claude` CLI (`adapter-claude/src/sdk-process.ts:17`, `session.ts:146`). OpenCode
   and Pi load JS plugins and extensions into the provider's own runtime.
5. **`@ace/core` runs outside the daemon too.** `fake-daemon` (46 files) folds facts with
   `apply`/`createThreadState` in the browser for web development and end-to-end tests, and
   `ui-core` and the iOS bridge scripts use its pure helpers.
6. **The store's licence and registry rules apply**: `native/daemon/deny.toml` allows only
   permissive licences (no MPL, no copyleft) and only crates.io.

## Decision

### 1. Each step's boundary is the interface its tests already use

A part moves behind the TypeScript interface its class (a) tests drive, chosen by a switch read
once at the I/O boundary. Unset is today's TypeScript; set without the addon, the daemon refuses
to start and says so (as `ACE_STORE=native` does, ADR 0222 §8).

| Step        | Boundary kept in TypeScript                                                                                                                            | Switch                        | What crosses N-API                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------- |
| Translators | `ProviderAdapter.createTranslator` → `Translator` (`translate`, `tick`, `nextDeadline`, `takeDiagnostics`)                                             | `ACE_TRANSLATORS=<providers>` | frame JSON in, facts JSON out, per batch                   |
| Supervisor  | `@ace/provider-kit/process`, `/jsonrpc`, `/streams`, `/jsonl`, `/tree-stop` exports                                                                    | `ACE_SUPERVISOR=native`       | spawn options in; line batches and exits out               |
| Sessions    | `ProviderAdapter.openSession` → `ProviderSession`                                                                                                      | `ACE_SESSIONS=<providers>`    | context in; frames out to `onFrame`; method calls in       |
| Core        | `@ace/core`'s exports (`apply`, `FactBatch`, `createThreadState`, `deriveAgentStatus`, `deriveThreadStatus`, `nextDeadline`, `DeadlineIndex`, helpers) | `ACE_CORE=native`             | facts in, events out; state stays native behind a handle   |
| Engine      | `Engine` (`engine/index.ts:80`) with `EngineOptions` and `CommandHandler`                                                                              | `ACE_ENGINE=native`           | commands in, results out; sync reads; JS ports called back |

Why these and not one engine-wide boundary from the start: each of them already has its own
class (a) tests (translators and fixtures 90 files, supervisor 28, sessions 113, core 39 plus the
5 test-kit files, engine 148), so each step is proven on its own and four of the five ship before the engine moves.

### 2. Crates

All in the `native/daemon` workspace, with its toolchain, lints and `deny.toml`; one crate per
adapter so builders work in parallel without touching each other's files and the compiler
builds them in parallel.

| Crate                                                                 | What it is                                                                                                                                                                               | Depends on                                                                                                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ace-protocol`                                                        | Rust types for the `@ace/protocol` values the engine reads and writes (`EventPayload`, `Item`, `AgentStatus`, `ThreadStatus`, `Command`, `ContentPart`, …), generated, never hand-edited | `serde`, `serde_json`                                                                                                                                                     |
| `ace-core`                                                            | The fact reducer: `Fact`, `ThreadState`, `apply`, `FactBatch`, status rules, deadlines. Pure: no I/O, no clock, no napi.                                                                 | `ace-protocol`                                                                                                                                                            |
| `ace-adapter-api`                                                     | The adapter interface: `Adapter`, `Translator`, `Session`, `SessionContext`, `Frame`, `InputRejected`, `SteerFence`                                                                      | `ace-protocol`, `ace-core`                                                                                                                                                |
| `ace-supervisor`                                                      | Process spawning, containment, inventory, stop plans, bounded line framing, output flow, JSON-RPC peer, SSE                                                                              | `tokio`, `tokio-util`, `process-wrap`, `rustix`, `windows-sys`, `sysinfo`, `procfs` (Linux), `libproc` (macOS), `eventsource-stream`, `ace-store` (the inventory journal) |
| `ace-adapter-codex`, `-claude`, `-cursor`, `-opencode`, `-acp`, `-pi` | Each provider's translator (`translate/`) and session (`session/`)                                                                                                                       | `ace-adapter-api`, `ace-supervisor`; ACP also `agent-client-protocol`; OpenCode also `reqwest`; Pi also `rmcp`                                                            |
| `ace-engine`                                                          | Actors, intents and queue, delivery, steering, sessions, access, recovery, restart, transitions, liveness                                                                                | `ace-store`, `ace-core`, `ace-adapter-api`, `futures`, `lru`, `thiserror`                                                                                                 |
| `ace-daemon-node`                                                     | The one addon; gains one module per step, translating values and errors and nothing else                                                                                                 | everything above, `napi` 3                                                                                                                                                |

Crates and why:

- **`tokio`** (multi-thread runtime, two workers) for the I/O only: `tokio::process`, pipes,
  sockets, HTTP and timers of native sessions. It is the established runtime for async process
  and network I/O and the one Spade already ships (`spade/Cargo.toml`, `tokio` 1.54).
- **`process-wrap`** (Apache-2.0/MIT, the maintained successor of `command-group`, used by
  watchexec) for process groups on POSIX, Job Objects on Windows and kill-on-drop, on
  `tokio::process`. It replaces `process-containment.ts` and the group handling of `process.ts`.
- **`rustix`** for the POSIX calls left: `killpg`, `prctl(PR_SET_CHILD_SUBREAPER)`, `waitid` on
  proven adoptions (`process-reaper.ts`). **`windows-sys`** 0.61 (Spade's version) for what
  `process-wrap` doesn't cover: `GetProcessTimes` and the token SID for identity, stdin-close stop
  (`tree-stop.ts`).
- **`sysinfo`** for listing processes and reading their environments (the `ACE_PROCESS_OWNER`
  sweep, `process-marker.ts:57`); **`procfs`** and **`libproc`** for exact kernel start times
  (identity is pid plus start time; `sysinfo`'s start time is in seconds, too coarse to rule out a
  reused pid).
- **`tokio-util`**'s `LinesCodec::new_with_max_length` for bounded line framing (over-long lines
  are dropped with a note, never fatal: behaviour.md §14) and `FramedRead` over pipes.
- **`eventsource-stream`** for OpenCode's SSE, over **`reqwest`** 0.13 (Spade's version) with
  `default-features = false` and no TLS feature: OpenCode is served on localhost only, and the TLS
  root bundles would bring licences `deny.toml` excludes.
- **`agent-client-protocol`** (Apache-2.0, the protocol's official Rust crate, the counterpart of
  the `@agentclientprotocol/sdk` the TypeScript adapter uses) for ACP's schema and its
  bidirectional JSON-RPC connection.
- **`rmcp`** 3.9 (Spade's version) for the MCP client the Pi adapter runs for its extension
  (today `@modelcontextprotocol/client`).
- **`futures`** for the engine's executor (section 4) and `LocalBoxFuture`; **`lru`** for the
  engine's bounded record cache (today `RecordBudget`, `engine/record-cache.ts`); **`thiserror`**
  for error enums.
- **`typify`** (Apache-2.0) at generation time only, to produce Rust types from JSON Schema:
  `ace-protocol` from the JSON Schema of `packages/protocol`'s Zod schemas (Zod 4's
  `z.toJSONSchema`), and the Codex app-server types from Codex's own schema export (question 3).
  Generated code is committed; `bun run check:daemon-native` regenerates it and fails on a diff,
  so `packages/protocol` stays the one source of truth (AGENTS.md: protocol is schema-only).
- One protocol layer is ours, small and kept: the JSON-RPC peer for Codex and the Cursor host
  (`jsonrpc.ts:61`, 300 lines). `jsonrpsee` was rejected: it is client-or-server, and these peers
  send requests both ways over one stdio pair (approvals arrive as requests from the provider).
- Rejected: `async-std`/`smol` as the I/O runtime (a second runtime beside Spade's tokio);
  `duct`/`subprocess` (blocking, no groups or job objects); `serde_json` `arbitrary_precision`
  (provider integers fit `f64` as they do in JS today, and JS numbers are the contract).

### 3. Frames decode leniently, raw kept

- A frame's data is held as `Box<serde_json::value::RawValue>`, exactly as received. Diagnostics
  and raw payloads are cut from it without re-encoding.
- A typed view is decoded from the raw data by matching the method or type string first; a known
  message deserializes into a generated or hand-written struct; an unknown one is an `Unknown {
  name, raw }` variant. Structs that read only some fields keep the rest in
  `#[serde(flatten)] rest: serde_json::Map`. No `deny_unknown_fields` anywhere.
- A known message that fails to deserialize is a `malformed` diagnostic with the frame's data and
  a `signal` fact, never an error (today's rule, `adapter-codex/src/translator.ts:594`–`:608`).
  Translators return `Vec<Fact>`, never `Result`; a panic inside one is caught at the binding and
  becomes the same diagnostic.
- Types come from the provider's own schema where it publishes one (Codex app-server, ACP,
  OpenCode's OpenAPI), generated with `typify` or taken from the official crate; Claude's
  stream-json and Pi's RPC have no published schema, so their structs are written by hand from the
  recorded fixtures, covering only what the translator reads. Clean-room: no code is taken from
  the providers' clients; schemas are data.

### 4. Concurrency: a single-threaded engine on the JS thread, I/O on tokio

- **The engine is async Rust on a local executor**, `futures::executor::LocalPool`, driven on the
  JS thread. Every input (a command, a frame batch, a timer, an I/O completion, a JS promise
  settling) is queued and followed by `pump()`, which runs the pool until it stalls and returns.
  Engine state is `Rc<RefCell<…>>`, never shared across threads, never locked.
- Why on the JS thread: the engine's transactions are the store's (fact 2), and the store's main
  connection serves 614 synchronous TypeScript callers on that thread (ADR 0222 §3). An engine on
  another thread would make every one of them, or the engine, cross threads synchronously, which
  ADR 0222 rejected for the store for the same reason.
- Why async on a local executor and not explicit state machines (sans-IO): the TypeScript engine's
  correctness lives in where it awaits and what it re-checks after (fact 3). Rust `async fn`s keep
  every yield point where it is, so the generation and lifetime checks port as they are and the
  race tests stay meaningful. The pure decisions (status rules, stop scope, steer choice, queue
  holds, restart eligibility) are plain functions in `ace-core` and `ace-engine::rules`, tested
  directly.
- Why not tokio for the engine: tokio's `LocalSet` needs a thread blocked in `block_on`, and the
  JS thread can't block. `LocalPool::run_until_stalled` is the primitive that returns to the event
  loop.
- **I/O runs on the addon's tokio runtime.** A native session's tasks spawn and read the process,
  frame lines, decode frames and send them on a bounded `tokio::sync::mpsc` channel to the engine.
  A non-blocking napi `ThreadsafeFunction`, coalesced by an atomic flag, schedules one `pump()` on
  the JS thread. Backpressure is the channel's bound plus today's `outputFlow` thresholds (pause at
  256 frames or a quarter of the byte limit, resume at 64 and a sixteenth, behaviour.md §4): a full
  channel stops the task reading the pipe, which stops the provider.
- **Time** comes from the `EngineOptions.clock` port: while the engine is on the JS thread the
  binding calls the JS clock (`now`, `setTimer`) whether it is `systemClock` or a test's
  `ManualClock`, so timer firing order is exactly today's. Ids likewise come from the `ids` port
  when one is given, else from the Rust port of `timeOrderedIds`
  (`apps/daemon/src/time-ordered-id.ts:11`), same format.
- **End state**: once agent-control and machines have moved and no TypeScript code calls
  `Store.atomic` synchronously, the engine and the store run together on one core thread, and the
  JS thread only sends commands and receives events. Because the engine is written for a
  single-threaded executor with injected time, that move changes its driver, not its code.

### 5. The Rust engine and the store share one transaction

- The engine step starts when store phase 5 has landed: the event writer, the live buffer,
  sequence reservation and the transaction stack (depth, savepoints, after-commit publication) in
  `ace-store`, with TypeScript's `Store.atomic` a facade over the same stack (ADR 0222 §7).
  Before that the steps here never write the store from Rust: translators, the supervisor and
  sessions hold no store state, and the core is pure.
- The Rust engine calls `ace_store` directly: `store.atomic(|tx| …)` around a command's receipt or
  a frame batch, `tx.append_events`, `tx.buffer_live_write`, its own tables (`intents`,
  `engine_queue`, `thread_state`, `engine_state_records`, the input journal and interaction
  ledger, `engine_provider_sessions`, … behaviour.md §17) through prepared statements on the same
  connection. A TypeScript `atomic` caller and a Rust one nest in one transaction, in either
  direction, because there is one stack.
- The engine's stored formats do not change in this ADR: the same tables, columns, JSON shapes and
  `engineSchemaVersion` 9 (`engine/schema-version.ts:6`). A home written with `ACE_ENGINE=native`
  opens with it unset, and the reverse; the switch is reversible with no data change. Which copies
  of an item body the engine may stop writing is ADR 0222's question 1 and is not decided here.

### 6. The socket server, MCP and agent-control keep talking to `Engine`

- `Engine` stays the TypeScript class every caller imports (33 non-test daemon files: the socket
  server, agent-control, machines, marketplace, services). With `ACE_ENGINE=native` it is a facade:
  each of its five kinds of method (behaviour.md §1) maps to one binding call of the same timing.
  Synchronous reads are synchronous napi calls returning finished JSON (as ADR 0222 §5 does for
  reads); synchronous mutations commit before returning; async methods return promises the Rust
  task resolves; `handler.handle` stays synchronous inside the store's receipt transaction.
- Published events still reach the socket server through `store.subscribe`; nothing about the wire
  changes.
- The ace MCP server stays TypeScript until agent-control moves. A session's `aceMcp` (URL,
  bearer, `session()`, `changes()`, `end()`) and `mcp` come from the `EngineOptions.mcp` and
  `sessionContext` ports, which the Rust engine calls back on the JS thread when it opens a session,
  and the values go to the session as data. MCP tool calls reach the engine through the same
  `Engine` facade methods they call today (`aceCaller`, `withinAgent`, `openHostApproval`,
  `delegationStarted`, …).
- `engine.hosts` and `engine.guests` (the Spade host threads and remote guests) become facade
  objects over the native engine with the same methods.

### 7. Adapters move one at a time, through a bridge both ways

- An adapter is three things, and each moves on its own switch: its translator (pure), its session
  (process and protocol), and any JS that runs in the provider's runtime or a host child, which
  stays TypeScript (fact 4).
- **Native session, TypeScript engine** (`ACE_SESSIONS` before `ACE_ENGINE`): the TypeScript
  adapter's `openSession` calls the addon, which returns an object implementing `ProviderSession`.
  Its frames reach the context's `onFrame` through a `ThreadsafeFunction`, and the session awaits
  the returned acknowledgement before reading more, which keeps backpressure. Context callbacks
  (`onSessionIdentity`, `onInputMessage`, `onCapabilities`, …) and the `AbortSignal` cross the same
  way.
- **TypeScript session, Rust engine** (`ACE_ENGINE` with a provider not in `ACE_SESSIONS`, and all
  scripted test adapters): `ace-engine`'s `Session` trait has a `JsSession` implementation in the
  binding that calls the JS `ProviderSession` and awaits its promises; the JS session's `onFrame`
  calls the native engine with the frame and gets the commit acknowledgement as a promise.
- **Native both**: frames go from the session's tokio task to the engine's channel and never become
  JS objects.
- Order of sessions, smallest risk first: Pi (JSONL over stdio, one process per session), Codex
  (JSON-RPC over stdio, shared host pool; the most used), ACP (official crate), OpenCode (HTTP and
  SSE, server pool, JS plugins stay), Cursor (Rust speaks the host wire; the host child running
  `@cursor/sdk` stays TypeScript). Claude: question 1.

### 8. Phases, each shippable alone

| Phase | What moves to Rust                                                                     | Switch                                                                                                                | Needs                                                    | Proven by                                                                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0    | Crate skeletons, `ace-protocol` generation and its check, switch parsing; no behaviour | none                                                                                                                  | ADR 0222 phase 1a                                        | `check:daemon-native`                                                                                                                                                                                       |
| E1    | Translators, one provider at a time                                                    | `ACE_TRANSLATORS`                                                                                                     | E0                                                       | That provider's translator and fixture (a) files (behaviour.md §19), and the engine files that use real translators: `adapter-echo`, `attachment-echo`, `recorded-ask`, `protocol-noise`, `history-replies` |
| E2    | The supervisor behind `@ace/provider-kit`'s process exports                            | `ACE_SUPERVISOR=native`                                                                                               | E0, `ACE_STORE=native` (the inventory journal is SQLite) | The 28 process-layer (a) files, then every adapter's session (a) files with the switch on                                                                                                                   |
| E3    | Sessions, one provider at a time                                                       | `ACE_SESSIONS`                                                                                                        | E1 and E2 for that provider                              | That provider's session (a) files; the engine's process tests that use the provider's fake CLI                                                                                                              |
| E4    | The core                                                                               | `ACE_CORE=native` (tests and tools; the daemon's TypeScript engine never uses it, as it reads `ThreadState` directly) | E0                                                       | The 39 core (a) files and the 5 test-kit files through the `@ace/core` facade                                                                                                                               |
| E5    | The engine, on the native core                                                         | `ACE_ENGINE=native`                                                                                                   | E4, ADR 0222 phase 5                                     | All 148 engine (a) files, the 56 other files that build an `Engine`, with translators and sessions in every combination of their switches                                                                   |

- E1, E2, E3 and E4 can be built in parallel; E5's modules are built in parallel too (the porting
  guide's work items) but ship under one switch: the engine's modules share actor state, and two
  engines owning different threads of one tree would make settle, delegation and liveness cross
  between them, which priority 1 does not allow.
- **The core facade.** With `ACE_CORE=native`, `createThreadState` returns an object holding a
  native `CoreThread`; `apply` and `FactBatch` fold on it and return events; the facade refreshes
  the object's `ThreadState` fields from the native state after each call, so tests that read
  `state.agents[...]` and `assertClientMatchesState` see the same shape. That refresh copies the
  whole state and exists for tests, the replay tools and `fake-daemon`; the Rust engine uses
  `ace-core` directly and has no such copy.
- **Default on** when its files pass on macOS, Linux and Windows (the Windows VM for E2 and E3),
  the relevant bench is no slower (`apps/daemon/bench/adapter-replay-facts.ts` for E1,
  `bench/scripted.ts` and `bench/stream-history.ts` for E5, `bench/sqlite-store.ts --split` for
  E5's commits), and it has run one release opt-in. A phase that misbehaves in the field is turned
  off by its switch; none of them changes stored data.
- **Deleting TypeScript.** A provider's TypeScript translator and session are deleted one release
  after its switches go default-on, the engine's likewise after E5; then (b) tests go with their
  modules (their cases already moved, section 9), the switch is removed, and the facade becomes
  the only path. Until then both implementations exist; nothing new is added to the TypeScript
  side of a module once its port has started.

### 9. Tests move, they don't multiply

- The class (a) files are the proof and are not edited. A builder runs each one alone, switch on
  and off (porting guide).
- A class (b) file's cases move into a `#[cfg(test)]` module beside the Rust function that replaces
  the TypeScript one, with the same inputs and expectations, and the TypeScript file is deleted
  with its module. No case is added or dropped in the move.
- No parity harness, no generated comparison vectors between the two implementations, no second
  suite. A new test is written only for behaviour no test covers today, and says so.
- Recorded fixtures stay the adapters' proof: `replayFixture` keeps calling the adapter's
  `createTranslator` and `@ace/core`, which are native behind their switches. No fixture is
  re-recorded for the port, and `tools/recorder` is not run.

## Consequences

- Each provider's protocol handling ends up in one Rust crate with its fixtures and fake CLIs as
  its proof; the daemon stops parsing provider output in JavaScript once E3 and E5 are on.
- Until E5, a native translator or session costs a JSON crossing per frame batch that today's code
  doesn't pay. It is measured in E1 and E3 before default-on; it disappears when engine and
  session are both native.
- The engine stays on the JS thread longer than the end state wants: a slow fold still delays the
  socket server, as today. Folding in Rust shortens that; moving off the JS thread waits for the
  last synchronous TypeScript `atomic` caller to go.
- A panic in a translator, session task or engine step is caught at the binding or the task
  boundary: a translator panic becomes a diagnostic, a session task panic ends that session as a
  provider exit, an engine step panic poisons that thread's actor as a failed commit does today
  (`actor.ts:271`). None takes the daemon down.
- `ace-core` is also wanted in the browser by `fake-daemon` (question 2); until that is decided the
  TypeScript reducer cannot be deleted.
- One more process-model fact to keep in mind: with the supervisor in Rust, processes the
  TypeScript shell still spawns (terminal, shells, probes) go through the same Rust supervisor and
  the same inventory, so there is one containment implementation, not two.

## Questions for the owner

1. **Claude's session.** The Agent SDK runs in the daemon today. Options: (a) leave Claude's
   session in TypeScript behind the session bridge; only its translator moves (recommended now:
   no new process, no protocol work); (b) run the SDK in a host child per account, as Cursor's
   SDK runs (one more Bun process per account; its memory is not measured yet); (c) speak the `claude` CLI's
   stream-json control protocol from Rust without the SDK, from the recorded frames and the fake
   CLI that already encode it (no SDK, but ace then owns a protocol the SDK owns today). Decide
   after Pi, Codex and ACP sessions are native?
2. **`@ace/core` in the browser.** `fake-daemon` folds facts with the reducer in the browser. Build
   `ace-core` to WebAssembly for it (one implementation; another wasm artifact like markit's), or
   keep the TypeScript reducer for `fake-daemon` only (a second implementation of the status rules,
   which AGENTS.md calls a bug)? Recommended: WebAssembly.
3. **Codex's protocol types.** Generate the Rust types with `typify` from Codex's JSON Schema export
   (the TypeScript types come from `codex app-server generate-ts`; whether 0.159.1 also has
   `generate-json-schema` must be checked without starting a session), or depend on the
   `codex-app-server-protocol` crate from OpenAI's repository (Apache-2.0, but a git dependency
   `deny.toml` doesn't allow today)? Recommended: generate.
4. **When the TypeScript goes.** One release after default-on (recommended), or kept longer as a
   fallback?
5. **Windows gate.** E2 and E3 default-on waits for the Windows VM run of the process-layer and
   session tests. Accept that gate?
6. **The engine on the JS thread** until agent-control and machines move (section 4). Accept, or
   move it to its own thread earlier at the cost of every synchronous `atomic` caller crossing
   threads?
