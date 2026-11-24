# 0223: The engine and provider adapters move to Rust behind the same interfaces

Date: 2026-11-23. Status: proposed (draft for the owner). Decided by: pending the owner.
Revised 2026-11-23 after review: writer ownership (§5, with ADR 0222 §3), the executor, pump and
wake protocol (§4), redaction (§3), the bridge's ordering and fence rules and the process journal
(§7), cross-mode gates (§8).
Revised again the same day after the second review: one scheduling claim for the pump and the
threadsafe-call failure (§4), today's acknowledgement point and flow control (§4, §7 rule 4),
the owner-thread check after preparation (§7 rule 1), the capture/wire split (§3), unconfirmed
close (§7 rule 5), the bounded startup pass (§5), responsiveness and its E5 measurement (§4, §8),
and cross-mode selected and asserted per boot of a home (§8). E0's file and switch names are
unchanged; only what `ACE_NATIVE_CROSS` means changed.

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

Of the 555 test files, 428 test behaviour through a public interface (class a), 64 test TypeScript
internals (b), none is redundant (c), and 63 cover code that stays TypeScript (behaviour.md §19).

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

| Step        | Boundary kept in TypeScript                                                                                                                                                   | Switch                        | What crosses N-API                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Translators | each adapter's exported translator class or factory, which `ProviderAdapter.createTranslator` returns → `Translator` (`translate`, `tick`, `nextDeadline`, `takeDiagnostics`) | `ACE_TRANSLATORS=<providers>` | frame JSON in, facts JSON out, per batch                   |
| Supervisor  | `@ace/provider-kit/process`, `/jsonrpc`, `/streams`, `/jsonl`, `/tree-stop` exports                                                                                           | `ACE_SUPERVISOR=native`       | spawn options in; line batches and exits out               |
| Sessions    | `ProviderAdapter.openSession` → `ProviderSession`                                                                                                                             | `ACE_SESSIONS=<providers>`    | context in; frames out to `onFrame`; method calls in       |
| Core        | `@ace/core`'s exports (`apply`, `FactBatch`, `createThreadState`, `deriveAgentStatus`, `deriveThreadStatus`, `nextDeadline`, `DeadlineIndex`, helpers)                        | `ACE_CORE=native`             | facts in, events out; state stays native behind a handle   |
| Engine      | `Engine` (`engine/index.ts:80`) with `EngineOptions` and `CommandHandler`                                                                                                     | `ACE_ENGINE=native`           | commands in, results out; sync reads; JS ports called back |

Why these and not one engine-wide boundary from the start: each of them already has its own
class (a) tests (translators and fixtures 90 files, supervisor 29, sessions 113, core 39 plus the
5 test-kit files, engine 149), so each step is proven on its own and four of the five ship before the engine moves.

### 2. Crates

All in the `native/daemon` workspace, with its toolchain, lints and `deny.toml`; one crate per
adapter so builders work in parallel without touching each other's files and the compiler
builds them in parallel.

| Crate                                                                 | What it is                                                                                                                                                                                      | Depends on                                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ace-protocol`                                                        | Rust types for the `@ace/protocol` values the engine reads and writes (`EventPayload`, `Item`, `AgentStatus`, `ThreadStatus`, `Command`, `ContentPart`, …), generated, never hand-edited        | `serde`, `serde_json`                                                                                                                                                     |
| `ace-json`                                                            | JSON as JavaScript sees it, for every crate here: `JSON.parse`/`JSON.stringify` semantics (lone surrogates, numbers, key order, duplicate keys), no recursion past a bounded depth, raw splices |
| `ace-core`                                                            | The fact reducer: `Fact`, `ThreadState`, `apply`, `FactBatch`, status rules, deadlines. Pure: no I/O, no clock, no napi.                                                                        | `ace-protocol`                                                                                                                                                            |
| `ace-core-wasm`                                                       | `ace-core` built to WebAssembly for `fake-daemon` in the browser: a thin `wasm-bindgen` binding, no logic                                                                                       | `ace-core`, `wasm-bindgen`                                                                                                                                                |
| `ace-adapter-api`                                                     | The adapter interface: `Adapter`, `Translator`, `Session`, `SessionContext`, `Frame`, `InputRejected`, `SteerFence`                                                                             | `ace-protocol`, `ace-core`                                                                                                                                                |
| `ace-supervisor`                                                      | Process spawning, containment, inventory, stop plans, bounded line framing, output flow, JSON-RPC peer, SSE                                                                                     | `tokio`, `tokio-util`, `process-wrap`, `rustix`, `windows-sys`, `sysinfo`, `procfs` (Linux), `libproc` (macOS), `eventsource-stream`, `ace-store` (the inventory journal) |
| `ace-adapter-codex`, `-claude`, `-cursor`, `-opencode`, `-acp`, `-pi` | Each provider's translator (`translate/`) and session (`session/`)                                                                                                                              | `ace-adapter-api`, `ace-supervisor`; ACP also `agent-client-protocol`; OpenCode also `reqwest`; Pi also `rmcp`                                                            |
| `ace-engine`                                                          | Actors, intents and queue, delivery, steering, sessions, access, recovery, restart, transitions, liveness                                                                                       | `ace-store`, `ace-core`, `ace-adapter-api`, `async-task`, `concurrent-queue`, `futures` (oneshot, `LocalBoxFuture`), `lru`, `thiserror`                                   |
| `ace-daemon-node`                                                     | The one addon; gains one module per step, translating values and errors and nothing else                                                                                                        | everything above, `napi` 3                                                                                                                                                |

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
- **`async-task`** and **`concurrent-queue`** for the engine's local executor (section 4);
  **`futures`** for `LocalBoxFuture` and oneshot channels; **`lru`** for the
  engine's bounded record cache (today `RecordBudget`, `engine/record-cache.ts`); **`thiserror`**
  for error enums.
- **`typify`** (Apache-2.0) at generation time only, to produce Rust types from JSON Schema:
  `ace-protocol` from the JSON Schema of `packages/protocol`'s Zod schemas (Zod 4's
  `z.toJSONSchema`), and the Codex app-server types from Codex's own schema export (question 1).
  Generated code is committed; `bun run check:daemon-native` regenerates it and fails on a diff,
  so `packages/protocol` stays the one source of truth (AGENTS.md: protocol is schema-only).
- One protocol layer is ours, small and kept: the JSON-RPC peer for Codex and the Cursor host
  (`jsonrpc.ts:61`, 300 lines). `jsonrpsee` was rejected: it is client-or-server, and these peers
  send requests both ways over one stdio pair (approvals arrive as requests from the provider).
- Rejected: `async-std`/`smol` as the I/O runtime (a second runtime beside Spade's tokio);
  `duct`/`subprocess` (blocking, no groups or job objects); `serde_json` `arbitrary_precision`
  (provider integers fit `f64` as they do in JS today, and JS numbers are the contract).

### 3. Frames decode leniently; the capture is redacted, the wire is not

- **The provider gets the original bytes; only the capture is redacted.** Each session builds one
  encoding of a message and uses it twice: the original goes to the transport, and a redacted copy
  becomes the frame the engine sees. Pi shows both paths in one function: `RpcWriter.send` gets the
  original `line`, and the `send` frame is built from `this.redact(line)` after the write
  completes (`adapter-pi/src/rpc.ts:70`–`:78`); received lines are redacted before capture
  (`:50`), and stderr likewise (`session.ts:263`). Codex captures `redactMcpCredential` of the
  encoding while its JSON-RPC peer writes the original (`adapter-codex/src/session.ts:129`,
  `mcp-server/src/injection.ts:212`); Claude likewise (`adapter-claude/src/session.ts:87`); ACP
  captures `redactedFrameJson` with the session's MCP secrets and leases, eliding attachment bytes
  past the bound (`adapter-acp/src/session.ts:361`–`:372`, `frame-redaction.ts:106`); OpenCode
  captures `server.redact` of the value (`adapter-opencode/src/session.ts:325`, `server.ts:112`).
  What the engine stores, translates and shows is the redacted capture; cleartext stays inside the
  session's own protocol handling and its writes to the provider.
- A native session keeps both paths distinct. Outbound: `admit` (§7 rule 1) pushes the original
  bytes onto the outbound queue and, once the writer has handed them to the transport, the session
  emits the `send` frame built from the redacted copy, in outbound order, as Pi does today.
  Inbound: the task decodes the original message for its own protocol needs (answering a request,
  tracking the turn), and the frame it queues for the engine is built, with its `Box<RawValue>`
  and admission size, from the redacted copy. Only capture copies cross the bridge in either
  direction: a native session hands the TypeScript engine redacted frames (E3), and a TypeScript
  session hands the Rust engine the redacted frames it already builds (E5); wire bytes never leave
  the session. Each adapter's redaction is ported with its session (porting guide E3) and its
  cases move with it (`frame-redaction`, `redaction`).
- "Raw kept" means: the redacted capture is held as produced by the redaction step, and
  diagnostics and raw payloads are cut from it without re-encoding.
- A typed view is decoded from that data by matching the method or type string first; a known
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

- **The engine is async Rust on a local executor built from `async-task`** (`spawn_local`) and a
  `concurrent-queue` ready queue, both from smol-rs (Apache-2.0/MIT; the parts `async-executor`
  is made of). Engine state is `Rc<RefCell<…>>`, never shared across threads, never locked. A task
  may be woken from any thread: its schedule function pushes the runnable onto the ready queue and
  notifies (below); runnables only ever run on the owning thread, which `async-task` checks.
  `futures::executor::LocalPool` was rejected: its wakers unpark a thread blocked in the pool and
  give no hook to schedule a pump on an event loop that never blocks, and entering it from inside
  another poll panics (`futures::executor::enter`).
- **Why on the JS thread**: the engine's transactions are the store's (fact 2), and the store's main
  connection serves 614 synchronous TypeScript callers on that thread (ADR 0222 §3, as amended:
  one connection, one owner, one transaction stack).
- **Why async and not explicit state machines (sans-IO)**: the TypeScript engine's correctness lives
  in where it awaits and what it re-checks after (fact 3). Rust `async fn`s keep every yield point
  where it is, so the generation and lifetime checks port as they are and the race tests stay
  meaningful. The pure decisions (status rules, stop scope, steer choice, queue holds, restart
  eligibility) are plain functions in `ace-core` and `ace-engine::rules`, tested directly.
- **Two kinds of entry, never mixed.**
  1. _Synchronous entries_ (`handler.handle`, the synchronous reads and mutations of
     behaviour.md §1) are plain functions on the engine state. They never run a runnable. They run
     inside the caller's open transaction, or open their own, and are scoped to it: work they start
     (a wake, a spawned task) is recorded on the store's after-commit queue of the outermost
     transaction and released only when it commits; a rollback discards it. This is today's
     `queueMicrotask` after the receipt (`engine/handler.ts:545`), made exact.
  2. _The pump_, the only place runnables run. It starts only from a Bun macrotask (the
     threadsafe function's callback, or a `setImmediate` the pump schedules itself), never from
     inside another binding call; never while the main connection has a transaction open (it
     checks the stack and re-arms); and never re-entrantly (a `Cell<bool>` guard; a nested request
     re-arms instead). A macrotask can't begin while synchronous JavaScript holds a transaction,
     because `Store.atomic` is synchronous, so the check only ever confirms what the event loop
     already guarantees. It is budgeted: it stops starting runnables after 64 of them or 4 ms,
     whichever comes first, and re-arms (below), so socket reads and timers interleave. Runnables
     for controls (a Stop's interrupt, an interaction's resolution, a task stop) wait in a ready
     queue of their own that each turn empties first.
- **JS ports during a step.** A task calls a JS port (a `clock.setTimer`, an `on*` callback, a
  `transitions` or `prepareInput` port) holding no `RefCell` borrow: state is reached only through
  short `with_state(|s| …)` closures whose type admits neither an await nor a port call. A port that
  calls back into the engine synchronously gets a synchronous entry (its borrow is free); an async
  method called back spawns a task and returns a promise, never running it inline.
- **A frame's acknowledgement comes where it does today**: when the actor's mailbox operation for
  its batch has run, which is either the commit of the batch's own transaction (outermost, because
  the pump never runs inside one) or, for established deltas, their acceptance into the live
  buffer, not the buffer's later flush (`engine/actor.ts:389`–`:394`, `:430`–`:441`). A buffered
  write that later fails to flush is handled as today: the store retries it, then quarantines the
  thread's live output and the actor fails visibly (behaviour.md §4, items 6 and 11). An
  acknowledgement never resolves on a savepoint's release; the binding asserts the outermost rule.
- **One scheduling claim for the pump.** One `AtomicU8` per engine holds `Idle`, `Scheduled`,
  `Running` or `RunningDirty`, and only the holder of the claim posts a notification:
  - a producer on any thread pushes its item (a runnable, a session event, an I/O completion,
    a timer firing), then moves `Idle → Scheduled` and, only if that move succeeded, posts the
    threadsafe function; from `Running` it moves to `RunningDirty` and posts nothing; from
    `Scheduled` or `RunningDirty` it does nothing;
  - the pump's entry, whether the threadsafe callback or its own continuation, moves
    `Scheduled → Running`; an entry that finds any other state returns at once (it is stale);
  - at the end of a turn the pump drains again if the state is `RunningDirty` (resetting it to
    `Running`) while budget remains; with budget spent and work left, it sets `Scheduled` and posts
    its continuation with `setImmediate`; with no work left it moves `Running → Idle`, and if that
    move fails because a producer made it `RunningDirty`, it drains once more.
    So a notification is posted only by the transition into `Scheduled`, by exactly one party, and
    at most one notification (threadsafe call or `setImmediate`) is ever pending. An item pushed at
    any point is either drained by the running turn or finds the state `Idle` and schedules one.
- **When the threadsafe call fails.** The function is created with an unbounded queue and only
  ever has one call pending, so `napi_queue_full` can't happen. `napi_closing` happens only once
  the function is released, and `Engine.close` releases it last: after every session task has
  ended, every timer is cancelled and a final pump has drained the queues (§7 rule 5). A
  `napi_closing` therefore means the environment is being torn down without `close` (a process
  exit): the producer logs it to stderr and leaves the state `Scheduled`, so nothing posts again.
  The items lost are frames nobody acknowledged, which restart recovery treats exactly as a crash's
  (behaviour.md §13).
- **Responsiveness, as far as it can be promised.** The budget is cooperative: a turn ends at the
  first step boundary after 4 ms, never inside a step. So a socket message or a Stop that arrives
  during a turn waits for the steps already started plus one, and is then handled: the Stop's
  receipt is a synchronous entry outside the pump, and its interrupt runs first in the next turn
  (control queue). What bounds a step is design, not the budget: no step does history-sized work
  (ADR 0170; the startup pass is batched, §5), a frame batch is at most 256 frames or 256 KiB
  (behaviour.md §4), and a step commits at most once. The longest part of a step is a commit,
  measured on the owner's 46 GB home under load at p95 11.6–15.2 ms and max 146 ms (ADR 0222,
  Measurements). That max is the honest worst case for one step today, and it is the same on the
  TypeScript engine, which commits on the same thread. No millisecond bound tighter than the
  commit distribution is promised; the E5 gate measures Stop and socket latency under a write
  burst and requires no regression against TypeScript (§8).
- **I/O runs on the addon's tokio runtime** (two workers). A native session's tasks spawn and read
  the process, frame lines, redact and decode, and push session events onto the session's ordered
  event queue (§7). Flow control is today's `outputFlow` (§7 rule 4): a paused session stops
  reading its pipe, which stops the provider; acknowledgements are tracked, not awaited.
- **Time** comes from the `EngineOptions.clock` port: while the engine is on the JS thread the
  binding calls the JS clock (`now`, `setTimer`) whether it is `systemClock` or a test's
  `ManualClock`, and a timer firing is a producer like any other, so firing order is today's. Ids
  likewise come from the `ids` port when one is given, else from the Rust port of
  `timeOrderedIds` (`apps/daemon/src/time-ordered-id.ts:11`), same format.
- **End state**: once agent-control and machines have moved and no TypeScript code calls
  `Store.atomic` synchronously, the engine and the store (its connection and stack) run together on
  one core thread, and the JS thread only sends commands and receives events. Because the engine
  is written for a single-threaded executor with injected time, that move changes its driver, not
  its code.

### 5. The Rust engine and the store: one connection, one owner, one transaction stack

- E5 starts when store phase 5 has landed, as ADR 0222 now specifies it (amended 2026-11-23 for
  this ADR): the transaction stack (depth, savepoints, after-commit publication), the event
  writer, the live buffer and sequence reservation in `ace-store`, **on the main connection, on the
  thread that owns it**, with TypeScript's `Store.atomic` a facade over the same stack. There is no
  writer thread and no second writing connection. A writer thread waiting for the connection while
  a synchronous receipt holds the write transaction on the JS thread would wait on a thread that
  cannot yield; a second connection would commit a receipt's events apart from the receipt. Both
  are ruled out.
- The Rust engine calls `ace_store` directly on that stack: `store.atomic(|tx| …)` around a
  command's receipt or a frame batch, `tx.append_events`, `tx.buffer_live_write`, its own tables
  (`intents`, `engine_queue`, `thread_state`, `engine_state_records`, the input journal and
  interaction ledger, `engine_provider_sessions`, … behaviour.md §17) through prepared statements
  on the same connection. A TypeScript `atomic` caller and a Rust one nest in one transaction, in
  either direction. The live buffer's flush is a task on the owning thread, run by the pump, so it
  is never inside another transaction.
- Before E5 nothing here writes the **event database** from Rust: translators and the core hold no
  stored state, and sessions hand frames to the TypeScript engine. One step writes another file:
  E2's supervisor keeps the **process journal** (`processes`, `escapees`, `kept`, `lineage`;
  `process-inventory.ts:85`, `escapee-journal.ts:28`–`:30`), a separate small SQLite file, opened
  through `ace-store`'s connection type so one SQLite library touches it (ADR 0222 constraint 2),
  with the identity encoding of §7a.
- **The startup pass is bounded and yields (a defect fixed, not carried over).** Today's pass
  finds the threads to recover with `recoveryStates` (`engine/repository.ts:255`–`:282`): pages of
  64, but each page runs a union that filters `threads` on `json_extract(status,'$.state')` and
  `intents` on `awaiting=1 OR uncertain=1`, which no index serves, so every page scans tables that
  grow with history. Readiness walks the candidates once, awaiting between threads
  (`engine/index.ts:464`), and `recoverEngine` then walks them twice more in one synchronous run
  (`engine/restart.ts:40`, `:342`, inside `:15`–`:415`). That breaks ADR 0170 today; behaviour.md §13
  records it. The Rust pass recovers exactly the same set, the same way, per thread, in its own
  transaction, but finds it in bounded steps: it pages each source by its primary key (`threads`
  by rowid, `intents` by `id`, `engine_queue` by `thread_id`) in slices of 256 rows, evaluating the
  same predicate, and runs each slice and each thread's recovery as a separate pump step, so the
  event loop runs between them. Commands are still refused with `engine_starting` until the pass
  has finished (`engine/index.ts:410`), so no thread takes a command before it is recovered, which
  is what keeps the recovered set and its order the same. No index is created at open (ADR 0170);
  if the owner wants recovery to need no scan at all, a recovery-candidate index built in idle
  batches is a later, separate change (question 5).
- The engine's stored formats do not change in this ADR: the same tables, columns, JSON shapes and
  `engineSchemaVersion` 9 (`engine/schema-version.ts:6`). A home written with `ACE_ENGINE=native`
  opens with it unset, and the reverse, which the cross-mode gate proves (§8). Which copies of an
  item body the engine may stop writing is ADR 0222's question 1 and is not decided here.

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
- **TypeScript session, Rust engine** (`ACE_ENGINE` with a provider not in `ACE_SESSIONS`, Claude
  until its question is reopened, and every scripted test adapter): `ace-engine`'s `Session` trait
  has a `JsSession` implementation in the binding that calls the JS `ProviderSession` and awaits its
  promises; the JS session's `onFrame` calls the native engine and gets the commit acknowledgement
  as a promise.
- **Native both**: session events go from the session's tokio task to the engine's queue and never
  become JS objects.

The bridge keeps five rules in every one of these combinations.

1. **Prepare anywhere; check last, on the owner thread, immediately before the enqueue.** Every
   adapter today does its asynchronous preparation first and checks the fence after its last
   await, right before the write: OpenCode awaits its admission lock and the session barrier, then
   checks, then issues the prompt request (`adapter-opencode/src/prompts.ts:52`–`:57`); Claude
   awaits the listing settle, encodes every frame, then checks and pushes into the SDK's input
   (`adapter-claude/src/session.ts:401`–`:410`); Cursor checks before its cancel write
   (`adapter-cursor/src/session.ts:246`–`:249`); ACP before its steering request
   (`adapter-acp/src/session.ts:645`); Pi checks, then `rpc.request` enqueues into `RpcWriter`'s
   FIFO in the same turn (`adapter-pi/src/session.ts:404`–`:410`, `rpc.ts:80`–`:88`,
   `provider-kit/src/rpc-writer.ts:33`–`:60`); Codex also compares `fence.turn` with the running
   turn (`adapter-codex/src/session-commands.ts:92`–`:95`). The contract: once admitted, a write
   reaches the provider before anything decided after it (a Stop's interrupt is queued behind);
   before admission, nothing has been sent. Across the bridge, every adapter keeps the same shape:
   - the session's preparation (locks, barriers, listing settles, encoding, redaction) runs
     wherever the session runs, on tokio for a native session;
   - then the session posts an admission request on its ordered event queue (rule 3) and waits;
   - on the owner thread (the JS thread, where the engine state lives) one synchronous step runs
     the final check and the enqueue, with nothing between them: `assertSteerTarget(delivery,
fence)` (the JS fence in E3, a Rust closure over engine state in E5); then, under the
     session's state lock, `fence.turn` against the turn the session last saw; then the push of
     the original bytes (or, for HTTP, the request) onto the session's ordered outbound queue;
   - the result (admitted, or `SteerTargetLost`) goes back to the waiting session task, whose
     writer then drains the outbound queue in order and decides nothing.
     A full outbound queue refuses at the enqueue with today's error (`JSON-RPC write queue exceeded
limit`, `rpc-writer.ts:36`), not `InputRejected`. With a TypeScript session (E5 before its
     provider's E3) the adapter's own code does all of this on the JS thread as today, with a fence
     whose `current()` is a synchronous entry into the engine (§4). A provider-side refusal keeps its
     mapping: a provider that says the turn is gone is `SteerTargetLost`
     (`session-commands.ts:133`). The steer race test (`adapter-codex/src/steer-race.process.test.ts`)
     and each adapter's `input-rejected.process` file guard it.
2. **Error identity crosses both ways.** Native to JS, the facade throws the engine-api classes
   (`new SteerTargetLost(message)`, `new InputRejected(message)`), so `instanceof` holds in
   `intent-delivery.ts` and the steer lane. JS to Rust, `JsSession` maps `instanceof SteerTargetLost`
   first, then `instanceof InputRejected`, to `SessionError::SteerTargetLost` and
   `SessionError::InputRejected`; anything else is a transport failure. `SteerTargetLost` is never
   retried into another turn on either side.
3. **One ordered event queue per session.** Frames, the exit, and the context callbacks
   (`onSessionIdentity`, `onSessionConfirmed`, `onInputMessage`, `onCapabilities`,
   `onPermissionMode`, `onAccountWait`, …) travel on one queue, in the order the session produced
   them, and are delivered in that order: every frame produced before the exit is handed to
   `onFrame` before `onExit` runs. Today `onExit` is enqueued on the actor behind the frames already
   accepted (`engine/sessions.ts:702`–`:711`; `enqueue` seals pending frames first,
   `actor.ts:191`–`:194`); an exit that overtook them would retire the generation and drop the final
   frames (`actor.ts:304`). The same holds for identity before echo (behaviour.md §8).
4. **Flow control is today's, and control is never blocked.** Today a session does not wait for
   each frame's acknowledgement before reading the next; it reads while the actor's `outputFlow`
   has room (pause at 256 frames or a quarter of the byte limit, resume at 64 and a sixteenth,
   `engine/actor.ts:84`–`:113`), which is what lets the actor batch up to 256 frames a commit. The
   bridge keeps that: the facade mirrors `outputFlow.paused()` into an atomic flag on the native
   session after each delivery and clears it when `outputFlow.wait()` resolves; the reader stops
   reading its pipe (or SSE stream) while the flag is set and is woken when it clears.
   Acknowledgements are tracked, not awaited: a rejected one (a failed commit) sets the session's
   failed flag and stops intake, as today (`engine/sessions.ts:684`–`:699`). The flag gates only
   reading from the provider; the queue to the JS side always drains, so a frame already read is
   always delivered. The exit and callbacks never wait on the flag, yet stay behind the frames
   before them.
   - **Cancelled while paused.** When the session's token is cancelled (a Stop's close, an idle or
     shutdown close), the reader stops honouring the pause and reads to EOF, still bounded by the
     process's output budget (`maxOutputBytes`, `provider-kit/src/process.ts:110`), and queues all of
     it; nothing read is dropped. Today's frames arriving during a close are delivered and
     committed while the generation is still current (`Sessions.close` flushes before and after
     `session.close`, `engine/sessions.ts:1062`–`:1072`), and the engine's own generation checks
     drop what it would drop today.
   - The stop plan (interrupt, SIGTERM, SIGKILL; behaviour.md §12) runs on its own task, never
     behind the reader, so cancel and exit make progress under any byte pressure.
5. **Close and shutdown.**
   - `close(reason)` resolves only on confirmed exit, as today's sessions do. If the provider
     doesn't confirm, it rejects and the native session stays whole: its reader, event queue and
     outbound queue stay open and it still owns the process, so the engine can restore it, as
     `Sessions.close` does (`engine/sessions.ts:1064`–`:1069`: "Without exit acknowledgement, the
     old process still owns the session"). Only a confirmed exit closes the queues.
   - Shutdown never joins on the JS thread: cancel the token; the stop plan ends the process; the
     reader reads to EOF and closes the event queue with the exit; the pump keeps running, because
     the threadsafe function stays referenced until every session queue is closed and drained; the
     session's `close()` promise resolves after the drain, and the task join completes on tokio
     and is reported through the queue. `Engine.close` flushes and stops the actors
     (`engine/index.ts:1428`–`:1466`) and releases the threadsafe function last (§4). Nothing waits
     synchronously on a tokio task.

**7a′. Group signals in the native supervisor.** A process group's number is signalled only
while ace holds its leader unreaped (the unreaped leader pins the group id). The leader is reaped
only after two consecutive empty scans while it is still held. Once the owner has given the group
up and the hold limit passes, the still-held group is killed by number through the daemon's guard,
and the reap waits for it to empty; a group that never empties is reported and stays held. After release there is nothing left to signal by group, and nothing is. Descendants that
left the group are stopped one by one by verified identity, as the subreaper's orphans
(behaviour.md §15).

**7a. The process journal, one encoding for both backends.** Rust writes and reads the journal rows
TypeScript writes today, byte for byte: `processes(pid INTEGER PRIMARY KEY, entry TEXT)` with the
JSON entry `process-inventory.ts` writes, and the `escapees`, `kept`, `lineage` tables
(`escapee-journal.ts:28`–`:30`). Identity is the strict `ProcessIdentity` (`pid`, `start`, `uid`,
`group`, `process-identity.ts:197`–`:203`) with `start` encoded exactly as today: Linux
`<boot_id>:<starttime ticks>` from `/proc/sys/kernel/random/boot_id` and field 22 of
`/proc/<pid>/stat`, read twice to confirm the process didn't change (`:244`–`:263`); macOS
`<pbi_start_tvsec>:<pbi_start_tvusec>` from `proc_pidinfo(PROC_PIDTBSDINFO)` (`:265`–`:281`);
Windows the creation `FILETIME` string and the owner SID (`:285`–`:291`). A row one backend wrote,
the other reads and acts on (sweeps, escapee stops, kept processes) the same way. E2 is not turned
on by default until the cross-backend journal recovery gate of §8 passes.

Known limits of E2a's supervisor, merged after fifteen review rounds (2026-11-23), to settle before
E2 is turned on by default. Neither can signal a process ace doesn't own, and agent state is never
wrong; at worst a leader is held unreaped or a record stays unresolved:

- **Userspace enumeration can miss a member.** A member that forks and hands off between the process
  list and its own check on every scan is not seen. The group number is never signalled either way.
- **Linux `hidepid=1` with non-dumpable members.** Unreadable pids are classified with `getpgid`, but
  a same-uid, non-dumpable orphan can stay hidden after it becomes a zombie, so release counts it as
  live and holds the leader. None of the Linux setups ace supports (Ubuntu, Fedora, Debian, Omarchy)
  mounts `/proc` with `hidepid` by default.

- Order of sessions, smallest risk first: Pi (JSONL over stdio, one process per session), Codex
  (JSON-RPC over stdio, shared host pool; the most used), ACP (official crate), OpenCode (HTTP and
  SSE, server pool, JS plugins stay), Cursor (Rust speaks the host wire; the host child running
  `@cursor/sdk` stays TypeScript). Claude's session stays TypeScript behind the bridge (decided
  below); its translator moves in E1.

### 8. Phases, each shippable alone

| Phase | What moves to Rust                                                                     | Switch                                                                                                                                                  | Needs                                                    | Proven by                                                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0    | Crate skeletons, `ace-protocol` generation and its check, switch parsing; no behaviour | none                                                                                                                                                    | ADR 0222 phase 1a                                        | `check:daemon-native`                                                                                                                                                                                                                     |
| E1    | Translators, one provider at a time                                                    | `ACE_TRANSLATORS`                                                                                                                                       | E0                                                       | That provider's translator and fixture (a) files (behaviour.md §19), and the engine files that use real translators: `adapter-echo`, `attachment-echo`, `recorded-ask`, `protocol-noise`, `history-replies`; the E1 cross-mode gate below |
| E2    | The supervisor behind `@ace/provider-kit`'s process exports                            | `ACE_SUPERVISOR=native`                                                                                                                                 | E0, `ACE_STORE=native` (the inventory journal is SQLite) | The 29 process-layer (a) files (`process-on-node.process` on Node), then every adapter's session (a) files with the switch on; the E2 cross-mode gate below (journal recovery across backends)                                            |
| E3    | Sessions, one provider at a time                                                       | `ACE_SESSIONS`                                                                                                                                          | E2                                                       | That provider's session (a) files; the engine's process tests that use the provider's fake CLI; the E3 cross-mode gate below                                                                                                              |
| E4    | The core, as the napi addon and as WebAssembly (`ace-core-wasm`)                       | `ACE_CORE=native` or `ACE_CORE=wasm` (tests, tools and `fake-daemon`; the daemon's TypeScript engine never uses it, as it reads `ThreadState` directly) | E0                                                       | The 39 core (a) files and the 5 test-kit files through the `@ace/core` facade with each loader; the 52 `fake-daemon` test files with `ACE_CORE=wasm`                                                                                      |
| E5    | The engine, on the native core                                                         | `ACE_ENGINE=native`                                                                                                                                     | E4, ADR 0222 phase 5 (as amended)                        | All 149 engine (a) files and the 56 other files that build an `Engine`, once with every provider's translator and session switched off and once with them on; the E5 cross-mode gate below                                                |

- E1, E2, E3 and E4 can be built in parallel (E3 lands after E2). A native session works with
  either translator, since translation runs wherever the engine runs. E5's modules are built in
  parallel too (the porting guide's work items) but ship under one switch: the engine's modules
  share actor state, and two engines owning different threads of one tree would make settle,
  delegation and liveness cross between them, which priority 1 does not allow.
- **The core facade.** With `ACE_CORE=native`, `createThreadState` returns an object holding a
  native `CoreThread`; `apply` and `FactBatch` fold on it and return events; the facade refreshes
  the object's `ThreadState` fields from the native state after each call, so tests that read
  `state.agents[...]` and `assertClientMatchesState` see the same shape. That refresh copies the
  whole state and exists for tests, the replay tools and `fake-daemon`; the Rust engine uses
  `ace-core` directly and has no such copy. The facade has two loaders over the same crate: the
  napi addon in Bun and Node, and `ace-core-wasm` in the browser (`fake-daemon`).
- **Cross-mode gate: the backend is chosen and recorded per boot of a home.** Running each file
  with the switch on and then off never tests rollback; the gate must show that a home written by
  one backend is resumed by the other. A process-wide alternation can't promise that: a crash and
  its recovery are sibling processes started the same way (`daemon-crash-test-support.ts:87`–`:91`
  spawns the crashing daemon, `daemon-launch-test-support.ts:39`–`:45` starts the next one with
  `daemonEnv(home)`), so both would inherit the same flipped value, and in-process alternation
  counts instances, not boots of one home. So `ACE_NATIVE_CROSS` (name and file as E0 has them,
  `packages/provider-kit/src/native-switches.ts`) works per boot:
  - A **boot** is the opening of a durable root: the event database for `ACE_STORE`,
    `ACE_TRANSLATORS`, `ACE_SESSIONS` and `ACE_ENGINE` (at the store's connection factory), the
    process journal for `ACE_SUPERVISOR` (at `ProcessInventory`'s open). Translators and sessions
    created after a boot take that boot's backend.
  - The backend of boot _n_ of a root is the switch's value for even _n_ and the opposite for odd
    _n_. _n_ is read from an append-only boot log outside the root (`ACE_NATIVE_CROSS_LOG`, one
    JSON line per boot: root path, _n_, switch, backend, pid), counted under an advisory file lock,
    so sibling processes, a crash and its recovery, and in-process restarts all count the same
    boots of the same root. `ACE_STORE` and `ACE_SUPERVISOR` take their value at a boot of a new
    process only, never twice in one process (ADR 0222, constraint 2).
  - The gate script (`scripts/native-cross.ts`, E0) runs each listed file once starting on and once
    starting off, then reads the log and **asserts per root** that every root with two or more boots
    alternated backends from its first boot, and that at least one root in the file booted twice.
    A file whose roots never boot twice fails the gate as "no restart", and leaves its list.
    The lists:
  - E1, per provider: `adapter-acp/src/integration-restart.test.ts` and the engine files that
    reopen a thread with that provider's real translator: `acp-resume-failure.process`,
    `acp-selection.process`, `codex-admission-restart.process`, `review-recovery.process`,
    `cursor-admission.process`, `cursor-recovery.process`, `restart-origin.process`. Native keys
    persisted in engine records (items, runs, interactions) must mean the same to both
    translators.
  - E2: `process-inventory.restart.process` (the crashing manager is a child process, `:39`–`:49`),
    `daemon-crash-recovery.process` (crash and recovery are siblings), `cursor-second-crash.process`:
    a journal written by one supervisor is recovered by the other (§7a), asserted per journal.
  - E3, per provider, its session files that recover or resume a saved session: Codex
    `item-invalidated-recovery.process`, `overlapping-recovery.process`, `review-recovery.process`;
    Cursor `checkpoint-recovery.process`, `recovered-seam.process`; OpenCode
    `ancestry-recovery.process`, `server-pool-recovery.process`; Pi
    `engine/pi-restart-resume.process` (the one test the owner allowed, porting guide E3-pi.2b);
    and the engine files of E1's list for that provider. A file a builder finds that resumes a session and isn't listed joins its
    provider's list; the assertion keeps any that never reboot out.
  - E4: none. The daemon never stores state through the core facade (the TypeScript engine
    persists its own `ThreadState`); E5's gate covers state the native core writes.
  - E5: the engine files that restart on one home: `acp-resume-failure`, `acp-selection`,
    `admission-recovery`, `context-meter`, `limit-recovery`, `queue-context`, `queue-recovery`,
    `restart-resume`, `resume-failure`, `startup-quarantine`, `stop-settles` (all through
    `restart`, `engine/recovery-test-support.ts:48`), `restart-origin` (through `crashCopy`),
    and `audit-reliability`, `context-handoff`, `cursor-fresh-session`, `cursor-recovery`,
    `cursor-transitions`, `defaults`, `delegation-transports`, `engine`, `real-thread-state`,
    `reliability`, `review-regressions`, `steer-fallback`, `storage-behaviour`, `thread-liveness`,
    `thread-switch` (each builds a second `Engine` on one home), plus `daemon-crash-recovery.process`.
    `machines/remote-child-lost-contact.process` is not on it: its restart case rebuilds the
    children ledger on the same engine (`:98`–`:105`), so no engine boots twice.
- **Default on** when its files pass on macOS, Linux and Windows (the Windows VM for E2 and E3),
  its cross-mode gate passes both ways, the relevant bench is no slower
  (`apps/daemon/bench/adapter-replay-facts.ts` for E1, `bench/scripted.ts` and
  `bench/stream-history.ts` for E5, `bench/sqlite-store.ts --split` for E5's commits), and it has
  run one release opt-in. E5 also needs **latency under load, not just throughput**:
  `apps/daemon/bench/head-of-line.ts` already times a Stop's acknowledgement (`stopAck`) and a
  send's receipt (`sendReceipt`) while bulk traffic runs, including a stream of deltas at full rate
  (`live`, `:96`), against a real engine; E5 runs it with `ACE_ENGINE` off and on, on the same
  machine and profiles, and must show p50, p99 and max of `stopAck` and `sendReceipt` no worse
  than TypeScript, with the main thread's event-loop delay (`head-of-line-daemon.ts`) reported
  beside them. A regression blocks default-on even if throughput improved. A phase that misbehaves in the field is turned off by its switch; none of
  them changes stored data, and the cross-mode gate is what shows that turning it off resumes
  every thread.
- **Where the translator switch sits.** Tests and sessions build translators through each
  adapter's exported constructor, not only through `createTranslator`:
  `new CursorTranslator(...)` (`adapter-cursor/src/diagnostics.test.ts:8`,
  `errors.process.test.ts`, `host-output.process.test.ts`, `recovered-seam.process.test.ts`,
  `adapter.ts:84`), `new OpenCodeTranslator(...)` (`replay.ts:20`, and inside the session,
  `adapter-opencode/src/session.ts:90`), `createCodexTranslator`, `createAcpTranslator`,
  `createPiTranslator`, Claude's `createTranslator`. The switch is therefore at each exported
  name: the exported class or factory is the native one when the switch names its provider. Those
  files then run the native translator unchanged.
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
- `ace-core` also runs in the browser: `fake-daemon` loads it as WebAssembly (decided below), so
  the TypeScript reducer is deleted once both the addon and the wasm build serve the facade.
- One more process-model fact to keep in mind: with the supervisor in Rust, processes the
  TypeScript shell still spawns (terminal, shells, probes) go through the same Rust supervisor and
  the same inventory, so there is one containment implementation, not two.

## Decided by the orchestrator, pending the owner (2026-11-23)

- **Claude's session (former question 1)**: the Agent SDK stays in TypeScript, in the daemon,
  behind the session bridge (§7, `JsSession`), for now. Claude's translator moves in E1; there is
  no E3 item for Claude. A host child per account or speaking the CLI's stream-json protocol from
  Rust is reconsidered after Pi, Codex and ACP sessions are native.

  **The owner, 2026-11-23: the Claude session moves to Rust later, in the providers work, not
  now.** Facts gathered for that work, so it starts from here:
  - **Why it pays.** Each line `claude` prints is parsed three times today: by ace
    (`adapter-claude/src/sdk-process.ts`, to inspect it), again by the SDK after ace writes it back
    as text into the SDK's stream, and again in Rust after the SDK's object is re-encoded to cross
    into the native translator (`ACE_TRANSLATORS=claude`). A Rust session parses each line once and
    hands JavaScript finished events only. The SDK (about 5 MB) and its per-session objects leave
    the daemon's heap. Facts still cross into JavaScript for the engine and store until E5 and
    store phase 5 land, so the CPU gain is partial before then; the memory gain is not.
  - **How.** A Rust session speaking the CLI's stream-json protocol directly (`-p
--input-format stream-json --output-format stream-json`), spawned through the E2 supervisor,
    behind the same session interface as the other E3 sessions and its own switch. Built as a
    standalone crate in `native/daemon` with a clean public API, so it may be published later.
  - **Terms.** Anthropic's Agent SDK docs support driving the CLI as a subprocess from other
    languages. The SDK itself is proprietary: write from the published headless docs and ace's
    recorded fixtures (`fixtures/claude/`); its `.d.ts` files may show which interfaces exist,
    its implementation is never read. ace drives the person's own unmodified `claude`, signed in
    through Anthropic's flow, and never touches credentials (ADR 0002). A published crate is never
    named `claude-code-*` or `anthropic-*`, and says products built on it should use API keys.
  - **Proof and gate.** The existing `adapter-claude` tests run against the Rust session (tests
    move, not multiply). `tools/daemon-bench`, whose fake provider is the `claude` CLI, gives the
    before and after for `cpuMsPerTurn` and heap; the switch defaults on only if they improve.
  - **Cost.** The SDK follows each CLI release for us today; once ace owns the protocol it must.
    Unknown control and stream messages are kept as raw data, never fatal.
  - **Cursor stays as it is.** `@cursor/sdk` is Cursor's whole proprietary agent talking to
    Cursor's private backend, so it is not ported. It keeps running in its own host child on the
    bundled runtime; only ace's side of that link moves to Rust (E3). With the daemon all Rust, the
    host becomes its own small bundle (or a `bun build --compile` program) started only for Cursor
    sessions.

- **`@ace/core` in the browser (former question 2)**: `ace-core` is built to WebAssembly as well
  (`ace-core-wasm`, a thin `wasm-bindgen` crate beside the napi binding, no logic of its own), and
  `fake-daemon` loads the `@ace/core` facade over it. One reducer, two loaders; no TypeScript
  reducer is kept for the browser.
- **Writer ownership (review, 2026-11-23)**: one connection, one owner, one transaction stack;
  no writer thread while TypeScript calls `Store.atomic` synchronously. Recorded in §5 here and in
  ADR 0222 §3 and phase 5.

## Questions for the owner

1. **Codex's protocol types.** Generate the Rust types with `typify` from Codex's JSON Schema export
   (the TypeScript types come from `codex app-server generate-ts`; whether 0.159.1 also has
   `generate-json-schema` must be checked without starting a session), or depend on the
   `codex-app-server-protocol` crate from OpenAI's repository (Apache-2.0, but a git dependency
   `deny.toml` doesn't allow today)? Recommended: generate.
2. **When the TypeScript goes.** One release after default-on (recommended), or kept longer as a
   fallback?
3. **Windows gate.** E2 and E3 default-on waits for the Windows VM run of the process-layer and
   session tests. Accept that gate?
4. **The engine on the JS thread** until agent-control and machines move (section 4). Accept, or
   move it to its own thread earlier at the cost of every synchronous `atomic` caller crossing
   threads?
5. **Startup recovery without a scan.** The bounded pass (§5) still reads every row of `threads`
   and `intents` once per start, in slices, before commands are taken. Build a recovery-candidate
   index in idle batches later so startup reads only candidates, or accept a sliced scan?
