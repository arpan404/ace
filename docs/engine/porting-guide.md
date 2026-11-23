# Porting the engine and provider adapters to Rust

For the builders who move the engine, the fact reducer, the process layer and the six provider
adapters to Rust, in parallel, one work item each. Read
[ADR 0223](../adr/0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md) and
[behaviour.md](behaviour.md) first: the contract there is what you keep, and behaviour.md §19
lists every test file by class. The store's
[porting guide](../store/porting-guide.md) sets the same rules for the store; where this guide is
silent, follow it.

Branch from `ace/rust-engine` once E0 has landed on it, one branch per work item
(`ace/rust-engine-<item>`).

## Rules for every work item

1. **Same TypeScript interface.** You replace what sits behind an interface, never the interface:
   each adapter's exported translator class or factory (`createCodexTranslator`,
   `createAcpTranslator`, `createPiTranslator`, Claude's `createTranslator`, and the classes
   `CursorTranslator` and `OpenCodeTranslator`, which tests and sessions construct with `new`),
   `openSession`/`ProviderSession`, `@ace/core`'s exports,
   `@ace/provider-kit`'s process exports, the `Engine` class. Signatures, return shapes, error
   classes (`InputRejected`, `SteerTargetLost`, `SessionOpenError`, `AccessError`), timing (what is
   synchronous stays synchronous) and the order of callbacks are contract.
2. **One switch, one line.** Your TypeScript shell file (table below) is chosen by one `if` at the
   top of the function or constructor you replace, reading the switch module from E0; for a
   translator class, the exported name itself is the native class when the switch names its
   provider (so `new CursorTranslator(...)` in `adapter-cursor/src/diagnostics.test.ts:8` gets the
   native one with no test change). Keep the edit to that line. With the switch on and the addon
   missing, fail; never fall back. Ask the switch module for a fresh decision at each new instance
   (it implements the cross-mode flip, rule 15).
3. **No new tests.** The class (a) files for your item are the proof; you don't edit them. Run each
   alone, switch on and off. Check the path exists first: an empty path runs the whole suite.

   ```sh
   f=packages/adapter-pi/src/translator.test.ts
   test -f "$f" && ACE_TRANSLATORS=pi bun --bun x vitest run "$f" --maxWorkers=4
   test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
   ```

   Never run the full suite, `bun run test`, `bun run check`, or `test:process`, `test:slow`,
   `test:changed`; the machine is shared. One file at a time.

4. **(b) cases move, they don't multiply.** For each class (b) file of your item, put its cases in a
   `#[cfg(test)] mod tests` beside the Rust function that replaces the TypeScript one: same inputs,
   same expectations, no case added or dropped. Delete the TypeScript test only when its module is
   deleted (after default-on), not in your work item.
5. **No parity harness.** No vectors generated from the TypeScript, no "run both and compare", no
   second suite. A new test only for behaviour nothing covers today, and the commit says which.
6. **Idiomatic, safe Rust.** No `unsafe` (the workspace denies it; the only unsafe code is
   `ace-store/src/sqlite.rs`, and you don't touch it); no `unwrap`/`expect` (clippy denies them).
   Errors are a `thiserror` enum per crate, mapped in the binding. Prefer the crates ADR 0223 §2
   names to writing your own; add another only with a reason in its `Cargo.toml` comment, and check
   it against `native/daemon/deny.toml` (permissive licences, crates.io only).
7. **Bindings only translate.** Every `#[napi]` export catches panics (`catch_unwind`) and turns
   them into JS errors; it takes handles and plain values, calls your crate, and returns JSON
   strings or plain values. Behaviour lives in your crate, never in `ace-daemon-node`.
8. **Lenient decoding** (ADR 0223 §3). Keep each frame's data as `Box<RawValue>`; match the
   method or type string, then decode; unknown types become an `Unknown` variant with the raw
   data; unknown fields stay (`#[serde(flatten)]`), never `deny_unknown_fields`. A translator
   returns `Vec<Fact>`, never `Result`, and never panics on provider data: a failed decode is a
   `malformed` diagnostic plus a `signal` fact, as the TypeScript does.
9. **Inject what you can't control.** No `SystemTime::now()`, no global RNG, no global runtime in
   logic: clock, ids, spawner and filesystem roots come in through the ports, as `EngineOptions`
   passes them today.
10. **Same numbers.** Limits, thresholds, budgets and timeouts are contract (behaviour.md §3, §4,
    §8, §12, §15): 256 frames or 256 KiB per batch, 1 ms batch latency, pause at 256 and resume at
    64 frames, 4 MiB frames, 16 MiB lines for Claude, 3 s/3 s/2 s stop plan, 5 minute idle release,
    64 active threads. Byte counts are UTF-8 bytes of the JSON the TypeScript measured.
11. **Never start provider CLIs or spend quota.** Tests use the fake CLIs in each adapter's
    `src/testing/`; never run `tools/recorder` or a `live` test. Never stop or restart the live
    ace daemon or app; never run a daemon or any ace command on a copy of `~/.ace`.
12. **Build and check.** In `native/daemon`:
    `PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH CARGO_BUILD_JOBS=4 cargo build --release -p ace-daemon-node`,
    then `bun run check:daemon-native` before each commit. Your own crate's tests:
    `cargo test -p <crate>`.
13. **Commit and push as you go** with `git push origin HEAD:refs/heads/<your-branch>`; never
    rebase or force-push. Every commit ends with exactly `Co-Authored-By: spade <bot@acehq.dev>`.
14. **Measure before you finish**, switch off and on, with the bench your item names, and report
    both figures.
15. **Cross-mode gate.** On/off runs never test rollback. Run your item's cross-mode list (ADR 0223
    §8) with `ACE_NATIVE_CROSS=<your switch>`, twice: once with your switch on (the first instance
    or process is native, the restarted one TypeScript) and once with it off (the reverse). Same
    rules as rule 3: one existing file at a time, no edits.

    ```sh
    f=apps/daemon/src/engine/restart-resume.process.test.ts
    test -f "$f" && ACE_STORE=native ACE_ENGINE=native ACE_NATIVE_CROSS=ACE_ENGINE bun --bun x vitest run "$f" --maxWorkers=4
    test -f "$f" && ACE_STORE=native ACE_NATIVE_CROSS=ACE_ENGINE bun --bun x vitest run "$f" --maxWorkers=4
    ```

16. **Redaction before capture.** Any frame you build is redacted before it becomes a payload or
    leaves your task, sent and received alike, with the adapter's secrets (behaviour.md §14, "Raw
    is post-redaction"); the raw data you keep is the redacted encoding.

## Files per work item

E0 creates every file below as a stub and declares every module, so no two builders edit the same
file. Paths in `native/daemon/crates/`.

| Item              | Rust (yours)                                                                          | Binding (yours)                                                                | TypeScript shell (yours)                                        | Switch                  |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------- |
| E1-codex … E1-pi  | `ace-adapter-<p>/src/translate/`                                                      | `ace-daemon-node/src/translate_<p>.rs`                                         | `packages/adapter-<p>/src/native-translator.ts`                 | `ACE_TRANSLATORS=<p>`   |
| E2a               | `ace-supervisor/src/{spawn,contain,identity,inventory,marker,reaper,stop,listing}.rs` | `ace-daemon-node/src/supervisor.rs`                                            | `packages/provider-kit/src/native-process.ts`                   | `ACE_SUPERVISOR=native` |
| E2b               | `ace-supervisor/src/{lines,budget,flow,jsonrpc,jsonl,sse}.rs`                         | `ace-daemon-node/src/streams.rs`                                               | `packages/provider-kit/src/native-streams.ts`                   | `ACE_SUPERVISOR=native` |
| E3-pi … E3-cursor | `ace-adapter-<p>/src/session/`                                                        | `ace-daemon-node/src/session_<p>.rs`                                           | `packages/adapter-<p>/src/native-session.ts`                    | `ACE_SESSIONS=<p>`      |
| E4                | `ace-core/src/`                                                                       | `ace-daemon-node/src/core.rs`                                                  | `packages/core/src/native.ts`                                   | `ACE_CORE=native`       |
| E5.1              | `ace-engine/src/{lib,executor,ports,registry,workers,limits}.rs`                      | `ace-daemon-node/src/engine/{mod,ports,js_session}.rs`                         | `apps/daemon/src/native-engine/{engine,ports}.ts`               | `ACE_ENGINE=native`     |
| E5.2 … E5.10      | `ace-engine/src/<module>.rs` (per item below)                                         | `ace-daemon-node/src/engine/<module>.rs` only if the item adds a facade method | `apps/daemon/src/native-engine/<module>.ts` only if it adds one | `ACE_ENGINE=native`     |

The switches live in `packages/provider-kit/src/native-switches.ts` (E0): each read once from the
environment at the I/O boundary. `ACE_SUPERVISOR`, `ACE_SESSIONS` and `ACE_ENGINE` refuse to
start without `ACE_STORE=native` (the supervisor's journal and the engine's tables are SQLite, and
one SQLite library per file is the rule, ADR 0222), as `apps/daemon/src/native-reads/switch.ts`
does for reads; `ACE_TRANSLATORS` and `ACE_CORE` touch no SQLite and need nothing else. The addon is loaded by the loader
`packages/provider-kit/src/native-sqlite.ts` already uses.

## E0: foundations (one builder, first)

- Create the crates of ADR 0223 §2 with their `Cargo.toml`, lints and module declarations; every
  file in the table above as a stub; `mod` lines in `ace-daemon-node/src/lib.rs` for every binding
  module.
- `ace-protocol`: a generator script `scripts/generate-rust-protocol.ts` that exports the JSON
  Schema of the `@ace/protocol` schemas the engine uses (`z.toJSONSchema`) and runs `typify`;
  committed output in `ace-protocol/src/generated.rs`; `check:daemon-native` regenerates and fails
  on a diff.
- `native-switches.ts` with the five switches (`ACE_CORE` takes `native` or `wasm`) and
  `ACE_NATIVE_CROSS=<switch>`: for the per-instance switches (`ACE_TRANSLATORS`, `ACE_SESSIONS`,
  `ACE_ENGINE`) each new instance takes the opposite backend from the one before, starting from
  the switch's value; for every switch, child processes inherit the opposite value; `ACE_STORE`
  and `ACE_SUPERVISOR` flip only across processes (ADR 0223 §8). A per-instance decision function
  for each switch, so the shells never read the environment themselves.
- `ace-core-wasm` as a stub crate (`wasm-bindgen`), built by a script beside the addon's.
- `ace-adapter-api`: the Rust form of `@ace/engine-api` (`Frame`, `Translator`, `Adapter`,
  `Session`, `SessionContext`, `InputRejected`, `SteerTargetLost`, `SteerFence`), with `Session`
  methods returning `LocalBoxFuture` (the engine's executor is single-threaded).
- The helpers every adapter item needs: port `binary-elision`, `elision`, `data-url` and `record`
  from `packages/provider-kit/src/` into `ace-adapter-api/src/util/` and move their (b) cases. The
  TypeScript modules stay for the daemon code that still uses them.
- Proof: `check:daemon-native` passes; no TypeScript test changes behaviour (no switch is on).

## E1: translators, one item per provider

Port the translator closure (the modules reached from `translator.ts` by value imports) to
`ace-adapter-<p>/src/translate/`, one Rust module per TypeScript module where that reads well.
The switch sits at the exported translator name (rule 2). `native-translator.ts` provides an
object implementing `Translator` that holds a native handle:
`translate(frame, now)` sends the frame as JSON and parses the facts; `tick`, `nextDeadline`,
`takeDiagnostics` likewise. Per-batch calls are better than per-frame if the shell can batch;
measure with `bun apps/daemon/bench/adapter-replay-facts.ts`.

| Item        | TypeScript replaced (`packages/adapter-<p>/src/`)                                                                                                                                                                                                                                                                                                                   | Lines | Proof: (a) files                                                                                        | (b) cases to move             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| E1-codex    | `translator`, `translate-delta`, `translate-item`, `translate-turn`, `item`, `command-items`, `interactions`, `interaction-lifecycle`, `answer-echo`, `pending-completions`, `history-assembly`, `retention`, `goal`, `mcp-approval`, `model`, `agent-registry`, `exit-diagnostic`, `native` (keys)                                                                 | 2,279 | Codex translator row of behaviour.md §19 (24 files), with `fixtures` replaying `fixtures/codex/0.159.1` | none                          |
| E1-claude   | `translator`, `state`, `blocks`, `content`, `tools`, `tasks`, `interactions`, `translate-interactions`, `compaction`, `consumed-inputs`, `injected-inputs`, `native-queue`, `pending-transcripts`, `missing-edges`, `steer-continuation`, `system-notices`, `provider-error`, `rate-limits`, `raw-facts`, `result-usage`, `token-counts`, `usage`, `goal`, `native` | 2,755 | Claude translator row (27 files), `fixtures/claude/2.1.286`                                             | none                          |
| E1-cursor   | `translator`, `transcript`, `children`, `delta-events`, `streamed-answer`, `tool-events`, `tools`, `recovered-tail`, `failure-kind`, `usage`, `contracts`                                                                                                                                                                                                           | 1,774 | Cursor translator row (10 files), `fixtures/cursor-sdk/1.0.35`                                          | none                          |
| E1-opencode | `translator`, `native-state`, `native-content`, `interactions`, `approval-target`, `boundaries`, `cache`, `data`, `redaction`, `usage`                                                                                                                                                                                                                              | 1,720 | OpenCode translator row (6 files), `fixtures/opencode/2.0.22`                                           | `native-content`, `redaction` |
| E1-acp      | `translator`, `state`, `lifecycle`, `settlement`, `association`, `children`, `content`, `tools`, `tool-final`, `tool-raw`, `completed-tools`, `shell-output`, `shell-settlement`, `prompt-hold`, `requests`, `interactions`, `keys`, `data`, `frame-redaction`, `quirks/generic`, `quirks/types`                                                                    | 2,681 | ACP translator row (18 files)                                                                           | `frame-redaction`             |
| E1-pi       | `translator`, `messages`, `tools`, `dialogs`, `turn-boundary`, `context-usage`, `native`                                                                                                                                                                                                                                                                            | 762   | Pi translator row (5 files)                                                                             | none                          |

Also run, switch on: `apps/daemon/src/engine/protocol-noise.test.ts`,
`adapter-echo.process.test.ts`, `attachment-echo.process.test.ts`,
`recorded-ask.process.test.ts`, `history-replies.process.test.ts` (each with the providers it
uses).

Contract: behaviour.md §5 (keys namespaced per process, turn bracketing, partial upserts, no ace
ids) and §14 (never throw, unknown kept as raw diagnostics, `adapter.warning` for bookkeeping
limits). The fact JSON must be what the TypeScript emits field for field, since core validates it,
and the native keys must be the same strings, since the engine stores them and the other backend
reads them after a restart: the E1 cross-mode list (ADR 0223 §8) proves it.

## E2: the supervisor (two items)

`native-process.ts` and `native-streams.ts` implement `@ace/provider-kit`'s exports over the
addon: `spawnSupervised`, `spawnRawSupervised`, `spawnRawSupervisedExactEnv`,
`spawnTextSupervised`, `probeOutput`, `ProcessLease`; `lineReader`, `JsonRpcPeer`, the SSE and
JSONL readers. The TypeScript callers (adapters, terminal, shells, probes) don't change.

| Item                      | TypeScript replaced (`packages/provider-kit/src/`)                                                                                                                                                                                                                                                                                                                                  | Proof: (a) files                                                                                                                                                                                                                                                                                                                                                                                                                                                    | (b) cases to move                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2a spawn and containment | `process`, `process-bytes`, `process-containment`, `process-env`, `process-identity`, `process-interactive`, `process-inventory`, `process-lineage`, `process-listing`, `process-marker`, `process-owner`, `process-reaper`, `process-signal`, `process-tree`, `process-watch`, `tree-stop`, `escapee-journal`, `directory-processes`, `child-exit`, `inventory-retry`, `bun-stdin` | `process.process`, `buffering.process`, `output-bounds.process`, `process-stop.process`, `fast-exit.process`, `directory-processes.process`, `process-bytes.process`, `process-owner.process`, `process-containment.process`, `process-identity.process`, `process-inventory.process`, `process-inventory.restart.process`, `process-interactive.process`, `process-interactive.native.process`, `process-env.process`, `tree-stop.process`, `probe-cancel.process` | `process-containment`, `process-identity`, `process-inventory`, `process-owner`, `process-ownership`, `process-tree`, `process-tree-state`, `process-env`, `inventory-retry` |
| E2b framing and protocols | `line-reader`, `line-segments`, `bounded-line-framing`, `output-budget`, `output-line-drop`, `byte-limit`, `flow-control`, `jsonl`, `jsonrpc`, `rpc-ids`, `rpc-owner`, `rpc-timers`, `rpc-writer`, `sse-parser`, `streams`                                                                                                                                                          | `line-backpressure.process`, `pressure-framing.process`, `jsonrpc.process`, `jsonrpc-boundary.process`, `jsonrpc-disposal.process`, `jsonrpc-lifetime.process`, `jsonrpc-limits.process`, `jsonrpc-replacement.process`, `sse-parser`, `jsonl`                                                                                                                                                                                                                      | `output-budget`, `dropped-line-notes`                                                                                                                                        |

Then run every adapter's session (a) files with `ACE_SUPERVISOR=native`: they spawn the fake CLIs
through this layer. Windows: job objects, tree-stop and identity must pass in the Windows VM before
default-on. Contract: behaviour.md §15. The inventory and escapee journal keep their SQLite file
and tables (`processes`, `escapees`, `kept`, `lineage`) and open through `ace-store`'s connection,
so TypeScript and Rust see one SQLite library. Rows and identities are byte-for-byte today's
(ADR 0223 §7a, behaviour.md §15): `start` is `<boot_id>:<ticks>` on Linux (read `stat` twice and
compare, `process-identity.ts:244`–`:263`), `<tv_sec>:<tv_usec>` on macOS (`:265`–`:281`), the
creation `FILETIME` and owner SID on Windows (`:285`–`:291`). `process-on-node.process` runs on
Node (it is in `nodeOnlySuites`, `scripts/test-tiers.ts:71`) against the native supervisor. Before default-on, the E2 cross-mode
list must pass both ways: a journal one backend wrote, the other recovers. Use `process-wrap` (groups, Job Objects,
kill-on-drop), `rustix`, `windows-sys`, `sysinfo`, `procfs`, `libproc`, `tokio-util`'s
`LinesCodec::new_with_max_length`, `eventsource-stream`.

## E3: sessions, one item per provider

`native-session.ts` implements `ProviderSession` over a native session handle (ADR 0223 §7). Keep
the bridge's five rules; each is guarded by tests you already run:

1. **Check and admit in one step.** `send` runs `assertSteerTarget(delivery, fence)` and then, in
   the same synchronous JS call, the binding's `admit`, which compares `fence.turn` with the turn
   the session last saw under the session's state lock, encodes, redacts, and pushes the bytes onto
   the ordered outbound queue. No await or thread hop between the check and the push; the tokio
   writer only drains in order. A full queue refuses at admission with today's error. Guarded by
   `adapter-codex/src/steer-race.process.test.ts` and each adapter's `input-rejected.process`.
2. **Error identity.** Throw the engine-api classes (`new SteerTargetLost(msg)`,
   `new InputRejected(msg)`) from the facade; map them back by `instanceof` in `JsSession`
   (`SteerTargetLost` first).
3. **One ordered event queue** per session carrying frames, callbacks and the exit, delivered to
   the context in production order: no frame produced before the exit reaches `onFrame` after
   `onExit`. Never deliver the exit on another path (a promise, a second threadsafe function).
4. **Backpressure counts frames only.** A frame waits for budget and for its acknowledgement in a
   `select!` with the session's cancellation token; the exit and callbacks never wait for budget
   but stay behind earlier frames; a rejected acknowledgement stops intake. The stop plan runs on
   its own task.
5. **Shutdown never joins on the JS thread.** Cancel the token, let the stop plan end the process,
   read to EOF, close the queue with the exit; keep the threadsafe function referenced until the
   queue is drained; resolve `close()` after the drain. Guarded by
   `adapter-codex/src/shutdown-drain.process.test.ts`, `engine/reliability.process.test.ts:348`
   and each session file's close cases.

Redaction (rule 16) happens in the task before a frame is queued. The TypeScript session code
stays until default-on.

| Item        | TypeScript replaced (`packages/adapter-<p>/src/`)                                                                                                                                                                                                                                                                                                                                                                                                                                          | Stays TypeScript                                                                                                                                                                                                                                                                                               | Proof: (a) files                                                    | (b) cases to move                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-pi       | `session`, `rpc`, `runtime`, `adapter`, `input`, `launch-args`, `session-header`, `session-references`, `fork-admission`, `history-errors`, `capabilities`, `extension-mcp` (use `rmcp`)                                                                                                                                                                                                                                                                                                   | `extension.ts`, `extension-api.ts` (run inside Pi)                                                                                                                                                                                                                                                             | Pi session row (13 files)                                           | `extension-mcp`, `launch-args`                                                                                                                                                     |
| E3-codex    | `session`, `app-server`, `host`, `host-pool`, `host-routing`, `thread-lease`, `session-lifetime`, `session-state`, `session-commands`, `session-discovery`, `runtime`, `selection`, `resolution`, `native-input`, `history`, `background-terminals`, `mcp-controls`, `extension-catalog`, `permission-policy`, `default-permissions`, `shell-env`, `rate-limits-read`, `tool-facts`, `tool-search`, `dropped-line`, `capabilities`                                                         | `account-login.ts`, `usage-read.ts`                                                                                                                                                                                                                                                                            | Codex session row (27 files)                                        | `shared-host.process`, `thread-lease.process`, `host-retire`, `dropped-line`, `permission-policy`, `session-lifetime`, `shell-env`, `tool-facts`, `tool-search`                    |
| E3-acp      | `session`, `adapter`, `negotiation`, `bridge-negotiation`, `configuration`, `deadlines`, `identity`, `resume-error`, `session-routing`, `quirks/antigravity`, `runtime` (use `agent-client-protocol`)                                                                                                                                                                                                                                                                                      | none                                                                                                                                                                                                                                                                                                           | ACP session row (14 files)                                          | `configuration`                                                                                                                                                                    |
| E3-opencode | `session`, `server`, `server-pool`, `owned-server`, `routes`, `runtime`, `admission`, `ancestry`, `cleanup`, `commands`, `history`, `input`, `installation`, `mcp-controls`, `mcp-locations`, `mcp-registration`, `metadata`, `metadata-failure`, `native-tools`, `observation`, `ownership`, `permission-policy`, `prompts`, `recovery`, `recovery-evidence`, `recovery-failure`, `text-coverage`, `capabilities`, `extension-catalog`, `agent-env` (use `reqwest`, `eventsource-stream`) | `agent-env-plugin/`, `mcp-ready-plugin/`, `agent-env-contract.ts`, `mcp-ready-contract.ts`, `contract.ts`, `mcp-ready.ts`, `sign-in*.ts`                                                                                                                                                                       | OpenCode session row (29 files)                                     | `mcp-locations`, `permission-policy`                                                                                                                                               |
| E3-cursor   | `session`, `adapter`, `host` (the daemon side of the host wire), `instance`, `slots`, `ack-budgets`, `agent-options`, `body-stream`, `checkpoints`, `legacy-checkpoints`, `event-identity`, `frame-batch`, `history`, `host-fatal`, `host-refusal`, `policy`, `recovery`, `run-seams`, `sdk-failure`, `sdk-images`, `sdk-input`, `shell-streams`, `text-stream`, `tool-guidance`, `unsettled`                                                                                              | `host-entry.ts`, `host-runtime.ts`, `host-wire.ts`, `sdk-store.ts`, `store-fence.ts`, `auth*.ts`, `api-key*.ts`, `login.ts`, `model-discovery.ts`, `runtime-boundary.ts`, `sandbox-helper.ts`, `sandbox-support.ts`, `user-settings.ts`, `user-tools.ts`, `ripgrep-path.ts` (run in the host child or sign-in) | Cursor session row (16 files) and the engine's Cursor row (9 files) | `host-ack.process`, `host-frame-storage.process`, `host-stderr.process`, `host-stop.process`, `host-stray-output.process`, `sdk-admission.process`, `frame-batch`, `tool-guidance` |
| E3-claude   | none: the SDK stays TypeScript behind the bridge (ADR 0223, decided by the orchestrator); its session files run unchanged                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                |                                                                     |                                                                                                                                                                                    |

Each also runs the engine process tests that use its provider's fake CLI with `ACE_SESSIONS` on
(grep `apps/daemon/src/engine/*.test.ts` for `@ace/adapter-<p>`). Before writing a byte to a
provider, read its recorded `send` frames in `fixtures/<p>/` and its fake CLI in `src/testing/`:
those are what the provider expects. Contract: behaviour.md §8 (generation and lifetime checks on
every callback, identity persisted before echo, exit behind frames), §10 (check and admission in
one step; `SteerTargetLost` never retried), §14 (raw is post-redaction) and §15. Then run your
provider's E3 cross-mode list (ADR 0223 §8) both ways.

## E4: the core

Port the reducer closure of `packages/core/src/`: `reduce`, `state`, `validate`, `status`,
`status-inputs`, `tree`, `runs`, `items`, `entities`, `cleanup`, `deadlines`, `expiry-map`,
`indexes`, `liveness`, `background-hold`, `human`, `external`, `emit`, `fact-data`,
`diagnostics`, `reconciled-item`, `item-input`, `output-snapshot`, `ace-tools` (3,744 lines), and
`facts.ts`'s `Fact` as a serde enum tagged by `type`. `native.ts` is the facade of ADR 0223 §8: a
`CoreThread` handle behind `createThreadState`, `apply` and `FactBatch` returning events, and the
`ThreadState` fields refreshed from the native state after each call so tests reading them see the
same shape (field names, optional fields omitted, not `null`). The other exports (`person-input`,
`provider-admission`, `provider-readiness`, `switch-route`, `steering`, `storage-retention`,
`permissions`, `fact-raw`, `shared-work`) stay TypeScript for now; the facade exports the reducer's
`isActionableInteraction` and other helpers it owns from Rust. The facade has two loaders over one
crate: the napi addon (`ace-daemon-node/src/core.rs`, Bun and Node) and `ace-core-wasm`
(`native/daemon/crates/ace-core-wasm/`, a `wasm-bindgen` binding with no logic of its own) for
`fake-daemon` in the browser; `ACE_CORE=wasm` selects the wasm loader under Node for tests.

- Proof: the 39 core (a) files and the 5 test-kit files with `ACE_CORE=native` and again with
  `ACE_CORE=wasm`; the 52 `packages/fake-daemon` test files with `ACE_CORE=wasm`; then every
  adapter translator (a) file with both `ACE_CORE=native` and `ACE_TRANSLATORS=<p>`. No cross-mode
  list: the daemon never stores state through the facade (ADR 0223 §8).
- Contract: behaviour.md §5 to §7. The status order of §6 is priority 1: port it rule for rule, in
  the same order, and keep the malformed-tree guard (`starting`, never settled).
- Ids: `ctx.ids.next(kind)` is called in the same order as today, so tests that count ids pass.

## E5: the engine

Needs E4 and ADR 0222 phase 5 as amended: the store's transaction stack and writer in Rust, on
the main connection and the JS thread; no writer thread (ADR 0223 §5). E5.1 lands first;
then E5.2, E5.3 and E5.4 in parallel; then E5.5 and E5.6; then E5.7 to E5.10 in parallel. The
TypeScript modules listed are in `apps/daemon/src/engine/`; the test-only modules there
(`*-test-support.ts`, `acp-resume-error-server.ts`, `cursor-real-host-*.ts`,
`cursor-recovery-child.ts`, `benchmark.ts`) stay TypeScript.

| Item                                     | TypeScript replaced                                                                                                                                                                                                                                                                                                                                                                                                  | Rust (`ace-engine/src/`)                                                                                                  | (a) files that prove it (behaviour.md §19 rows)                                                                                                   | (b) cases to move                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E5.1 skeleton                            | `index` (as the facade), `engine-options`, `registry`, `adapters`, `workers`, `limits`                                                                                                                                                                                                                                                                                                                               | `lib`, `executor` (async-task runnables, ready queue, wake flag, budgeted pump), `ports`, `registry`, `workers`, `limits` | first green: `engine.process`, `main-integration.process` (with E5.2 to E5.4)                                                                     | `adapters`, `registry`                                                                                                                                                                     |
| E5.2 actor and frames                    | `actor`, `frame-envelope`, `delta-batch`, `raw`, `fact-bytes`, `attachment-echo`, `attachment-correlations`, `attachment-payload`, `stream-facts`                                                                                                                                                                                                                                                                    | `actor`, `frames`                                                                                                         | storage row; `signal-batching`, `sdk-burst`, `streaming-behaviour`                                                                                | `actor-timer`, `frame-envelope`, `fact-bytes`                                                                                                                                              |
| E5.3 persistence                         | `repository`, `persistence`, `records`, `record-cache`, `snapshot`, `append`, `item-metadata`, `schema-version`, `migrations`, `store-generations`, `execution-provenance`, `provider-facts`                                                                                                                                                                                                                         | `repository`, `snapshot`, `records`                                                                                       | storage row; `records-write-budget`, `schema-compatibility`, `startup-quarantine`, `cold-state`                                                   | `item-metadata`, `audit-record-cache.process`, `record-budget.process`, `snapshot-retention.process`, `open-text-restart.process`, `snapshot-release.process`, `snapshot-rollback.process` |
| E5.4 commands, intents, queue            | `handler`, `intents`, `queue-store`, `queue-commands`, `create-thread`, `creation-admissions`, `creation-validation`, `input`, `input-journal`, `input-delivery`, `input-fate`, `stale-inputs`, `message-facts`, `person-command`, `title-input`, `thread-posts`, `transcript-inputs`, `ace-inputs`, `ace-input-attribution`, `ace-waits`, `edited-context`, `goal-change`, `guest-admission`, `workspace-directory` | `commands`, `intents`, `queue`, `inputs`                                                                                  | commands row (31 files)                                                                                                                           | `edited-context`, `retired-bot-threads`                                                                                                                                                    |
| E5.5 delivery and steering               | `intent-delivery`, `delivery`, `steer-lane`, `steer-selection`, `steer-yield`, `steer-notes`, `turn-origin`, `root-run-start`, `resolution`                                                                                                                                                                                                                                                                          | `delivery`, `steering`                                                                                                    | steering row; `submission`, `input-fate`, `input-leases`, `held-send-release`, `resolution`, `interaction-replay`                                 | `steer-yield`, `root-run-start`                                                                                                                                                            |
| E5.6 sessions                            | `sessions`, `provider-sessions`, `session-metadata`, `session-open-route`, `session-fenced`, `resume-open-error`, `provider-errors`, `failure-copy`, `provider-release`, `slot-reclaim`, `background-ports`, `agent-env`, `account-route`, `models`, `selection-notices`, `provider-command-metadata`, `context-meter`, `context-sample`, `silence`, `startup-skip`                                                  | `sessions`, `release`, `models`, `meters`                                                                                 | `open-failure`, `provider-release`, `resource-limits`, `model-selection`, `context-meter`, `provider-context-meter`, `socket-liveness`, `silence` | `agent-env`                                                                                                                                                                                |
| E5.7 access and approvals                | `permissions`, `permission-ceiling`, `permission-storage`, `access-defaults`, `ace-approvals`, `interaction-ledger`, `host-threads`, `guest-threads`                                                                                                                                                                                                                                                                 | `access`, `approvals`, `hosts`                                                                                            | access row; `execution-approval`, `guest-admission`                                                                                               | `ace-approvals`, `permission-ceiling`                                                                                                                                                      |
| E5.8 recovery and restart                | `recovery`, `restart`, `restart-resume`, `restart-eligibility`, `restart-captures`, `provider-recovery`, `provider-return`, `cursor-reconcile`, `cursor-attempt`, `cursor-empty-migration`, `recover-limited-children`, `lost-work`, `session-bound-tasks`, `imported-thread`                                                                                                                                        | `recovery`, `restart`, `cursor_reconcile`                                                                                 | restart row, limits row, Cursor row                                                                                                               | `restart-origin.process`, `cursor-attempt-record`, `restart-ledgers.process`, `session-bound-tasks.process`, `cursor-migration.process`                                                    |
| E5.9 transitions                         | `transitions`, `transition-handler`, `transition-state`, `transition-readiness`, `transition-history`, `switch-admission`, `switch-recovery`, `fork-history`, `fork-replay`, `machine-handoff`, `live-move`, `workspace-change`, `store-handoff`                                                                                                                                                                     | `transitions`, `moves`                                                                                                    | transitions row (17 files)                                                                                                                        | none                                                                                                                                                                                       |
| E5.10 liveness, stop, settle, delegation | `thread-liveness`, `settled-trees`, `stop-intents`, `stop-scope`, `snooze-wake`, `delegation-facts`, `child-attachment`, `remote-child-status`, `long-thread-child`                                                                                                                                                                                                                                                  | `liveness`, `settle`, `delegation`                                                                                        | stop row; `thread-liveness`; the 56 files outside `engine/` that build an `Engine` (agent-control, machines)                                      | `settled-hold`                                                                                                                                                                             |

`worktree-title.ts` stays TypeScript (git branch naming); the engine calls it through the
`worktreeGit` port.

For every E5 item:

- The facade (`native-engine/engine.ts`) keeps all of `Engine`'s public methods with the same
  timing (behaviour.md §1): synchronous reads as synchronous binding calls returning JSON, async
  methods as promises the Rust task resolves, `handler.handle` synchronous inside the receipt
  transaction. `engine.hosts` and `engine.guests` are facade objects too.
- Every `EngineOptions` port the test passes is called back on the JS thread at the point the
  TypeScript calls it today: `clock`, `batchScheduler`, `ids`, `threadId`, `commandId`,
  `transitions`, `recovery`, `prepareInput`, `prepareWorkspace`, `beforeSend`, `models`, `mcp`,
  `sessionContext`, the `on*` callbacks. Scripted and TypeScript adapters go through `JsSession`.
- Port the awaits where they are (ADR 0223 §4): every generation, lifetime and `holdToken` check
  after an await stays after that await. Reach state only through `with_state(|s| …)` closures,
  which can't await or call a port.
- Two kinds of entry, never mixed (ADR 0223 §4, E5.1 owns the machinery): synchronous entries are
  plain functions that never run a task and whose wakes and spawns go on the outermost
  transaction's after-commit queue (dropped on rollback); the pump is the only place tasks run, from
  a Bun macrotask only, never inside a binding call or an open transaction or another pump, at most
  64 tasks or 4 ms a turn. The wake flag is cleared before the drain, never after. A frame batch's
  acknowledgement resolves only on the outermost commit. Guarded by `engine/reliability.process`,
  `signal-batching.process`, `storage-behaviour.process` and `live-write-buffer.process`; a
  re-entrant call from a port must not panic in any (a) file.
- Graceful close (E5.8): per thread, flush, then capture restart evidence (continuation and the
  open request it waits on, `recovery.ts:293`–`:303`) **before** any session closes, then close the
  sessions (behaviour.md §2). Guarded by `restart-resume.process.test.ts:345`, `:357`, `:384`.
- Lost contact (E5.10): a remote child's hold is never ended by lost contact; the child reads
  `needs_you` with the person's question on its agent (behaviour.md §12). Guarded by
  `machines/remote-child-lost-contact.process.test.ts`.
- Run the E5 cross-mode list (ADR 0223 §8) both ways before you report.
- Transactions are `ace_store`'s (`store.atomic`), the same stack TypeScript's `Store.atomic` uses;
  tables, columns, JSON shapes and `engineSchemaVersion` 9 don't change. A home written with the
  switch on must open with it off, which the cross-mode list proves.
- Measure with `bun apps/daemon/bench/scripted.ts`, `bun apps/daemon/bench/stream-history.ts` and
  `bun apps/daemon/bench/agent-control.ts`, switch off and on.

## When you are done

- Every (a) file of your item passes alone with the switch on and off; your (b) cases pass as
  `cargo test -p <crate>`; `check:daemon-native` passes.
- Report: the files run and their results, the bench figures off and on, any behaviour you found
  no test for (and the one test you added for it, if any), and anything in behaviour.md that turned
  out wrong, with the code that shows it.
