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
   `createTranslator`/`Translator`, `openSession`/`ProviderSession`, `@ace/core`'s exports,
   `@ace/provider-kit`'s process exports, the `Engine` class. Signatures, return shapes, error
   classes (`InputRejected`, `SteerTargetLost`, `SessionOpenError`, `AccessError`), timing (what is
   synchronous stays synchronous) and the order of callbacks are contract.
2. **One switch, one line.** Your TypeScript shell file (table below) is chosen by one `if` at the
   top of the function or constructor you replace, reading the switch module from E0. Keep the
   edit to that line. With the switch on and the addon missing, fail; never fall back.
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
- `native-switches.ts` with the five switches.
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
`native-translator.ts` returns an object implementing `Translator` that holds a native handle:
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
limits). The fact JSON must be what the TypeScript emits field for field, since core validates it.

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
so TypeScript and Rust see one SQLite library. Use `process-wrap` (groups, Job Objects,
kill-on-drop), `rustix`, `windows-sys`, `sysinfo`, `procfs`, `libproc`, `tokio-util`'s
`LinesCodec::new_with_max_length`, `eventsource-stream`.

## E3: sessions, one item per provider

`native-session.ts` implements `ProviderSession` over a native session handle
(ADR 0223 §7): context in, frames out to `onFrame` through a threadsafe function whose returned
acknowledgement the Rust task awaits before reading more, callbacks and the `AbortSignal` the same
way. The TypeScript session code stays until default-on.

| Item        | TypeScript replaced (`packages/adapter-<p>/src/`)                                                                                                                                                                                                                                                                                                                                                                                                                                          | Stays TypeScript                                                                                                                                                                                                                                                                                               | Proof: (a) files                                                    | (b) cases to move                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-pi       | `session`, `rpc`, `runtime`, `adapter`, `input`, `launch-args`, `session-header`, `session-references`, `fork-admission`, `history-errors`, `capabilities`, `extension-mcp` (use `rmcp`)                                                                                                                                                                                                                                                                                                   | `extension.ts`, `extension-api.ts` (run inside Pi)                                                                                                                                                                                                                                                             | Pi session row (13 files)                                           | `extension-mcp`, `launch-args`                                                                                                                                                     |
| E3-codex    | `session`, `app-server`, `host`, `host-pool`, `host-routing`, `thread-lease`, `session-lifetime`, `session-state`, `session-commands`, `session-discovery`, `runtime`, `selection`, `resolution`, `native-input`, `history`, `background-terminals`, `mcp-controls`, `extension-catalog`, `permission-policy`, `default-permissions`, `shell-env`, `rate-limits-read`, `tool-facts`, `tool-search`, `dropped-line`, `capabilities`                                                         | `account-login.ts`, `usage-read.ts`                                                                                                                                                                                                                                                                            | Codex session row (27 files)                                        | `shared-host.process`, `thread-lease.process`, `host-retire`, `dropped-line`, `permission-policy`, `session-lifetime`, `shell-env`, `tool-facts`, `tool-search`                    |
| E3-acp      | `session`, `adapter`, `negotiation`, `bridge-negotiation`, `configuration`, `deadlines`, `identity`, `resume-error`, `session-routing`, `quirks/antigravity`, `runtime` (use `agent-client-protocol`)                                                                                                                                                                                                                                                                                      | none                                                                                                                                                                                                                                                                                                           | ACP session row (14 files)                                          | `configuration`                                                                                                                                                                    |
| E3-opencode | `session`, `server`, `server-pool`, `owned-server`, `routes`, `runtime`, `admission`, `ancestry`, `cleanup`, `commands`, `history`, `input`, `installation`, `mcp-controls`, `mcp-locations`, `mcp-registration`, `metadata`, `metadata-failure`, `native-tools`, `observation`, `ownership`, `permission-policy`, `prompts`, `recovery`, `recovery-evidence`, `recovery-failure`, `text-coverage`, `capabilities`, `extension-catalog`, `agent-env` (use `reqwest`, `eventsource-stream`) | `agent-env-plugin/`, `mcp-ready-plugin/`, `agent-env-contract.ts`, `mcp-ready-contract.ts`, `contract.ts`, `mcp-ready.ts`, `sign-in*.ts`                                                                                                                                                                       | OpenCode session row (29 files)                                     | `mcp-locations`, `permission-policy`                                                                                                                                               |
| E3-cursor   | `session`, `adapter`, `host` (the daemon side of the host wire), `instance`, `slots`, `ack-budgets`, `agent-options`, `body-stream`, `checkpoints`, `legacy-checkpoints`, `event-identity`, `frame-batch`, `history`, `host-fatal`, `host-refusal`, `policy`, `recovery`, `run-seams`, `sdk-failure`, `sdk-images`, `sdk-input`, `shell-streams`, `text-stream`, `tool-guidance`, `unsettled`                                                                                              | `host-entry.ts`, `host-runtime.ts`, `host-wire.ts`, `sdk-store.ts`, `store-fence.ts`, `auth*.ts`, `api-key*.ts`, `login.ts`, `model-discovery.ts`, `runtime-boundary.ts`, `sandbox-helper.ts`, `sandbox-support.ts`, `user-settings.ts`, `user-tools.ts`, `ripgrep-path.ts` (run in the host child or sign-in) | Cursor session row (16 files) and the engine's Cursor row (9 files) | `host-ack.process`, `host-frame-storage.process`, `host-stderr.process`, `host-stop.process`, `host-stray-output.process`, `sdk-admission.process`, `frame-batch`, `tool-guidance` |
| E3-claude   | not started: ADR 0223, question 1; Claude's five (b) files wait with it                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                                                                                                                                                                                                                                                                                |                                                                     |                                                                                                                                                                                    |

Each also runs the engine process tests that use its provider's fake CLI with `ACE_SESSIONS` on
(grep `apps/daemon/src/engine/*.test.ts` for `@ace/adapter-<p>`). Before writing a byte to a
provider, read its recorded `send` frames in `fixtures/<p>/` and its fake CLI in `src/testing/`:
those are what the provider expects. Contract: behaviour.md §8 (generation and lifetime checks on
every callback, identity persisted before echo), §10 (`SteerFence` checked synchronously right
before the write; `SteerTargetLost` never retried), §14 and §15.

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
`isActionableInteraction` and other helpers it owns from Rust.

- Proof: the 39 core (a) files and the 5 test-kit files with `ACE_CORE=native`, then every
  adapter translator (a) file with both `ACE_CORE=native` and `ACE_TRANSLATORS=<p>`.
- Contract: behaviour.md §5 to §7. The status order of §6 is priority 1: port it rule for rule, in
  the same order, and keep the malformed-tree guard (`starting`, never settled).
- Ids: `ctx.ids.next(kind)` is called in the same order as today, so tests that count ids pass.

## E5: the engine

Needs E4 and ADR 0222 phase 5 (the store's transaction stack and writer in Rust). E5.1 lands first;
then E5.2, E5.3 and E5.4 in parallel; then E5.5 and E5.6; then E5.7 to E5.10 in parallel. The
TypeScript modules listed are in `apps/daemon/src/engine/`; the test-only modules there
(`*-test-support.ts`, `acp-resume-error-server.ts`, `cursor-real-host-*.ts`,
`cursor-recovery-child.ts`, `benchmark.ts`) stay TypeScript.

| Item                                     | TypeScript replaced                                                                                                                                                                                                                                                                                                                                                                                                  | Rust (`ace-engine/src/`)                                    | (a) files that prove it (behaviour.md §19 rows)                                                                                                   | (b) cases to move                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E5.1 skeleton                            | `index` (as the facade), `engine-options`, `registry`, `adapters`, `workers`, `limits`                                                                                                                                                                                                                                                                                                                               | `lib`, `executor`, `ports`, `registry`, `workers`, `limits` | first green: `engine.process`, `main-integration.process` (with E5.2 to E5.4)                                                                     | `adapters`, `registry`                                                                                                                                                                     |
| E5.2 actor and frames                    | `actor`, `frame-envelope`, `delta-batch`, `raw`, `fact-bytes`, `attachment-echo`, `attachment-correlations`, `attachment-payload`, `stream-facts`                                                                                                                                                                                                                                                                    | `actor`, `frames`                                           | storage row; `signal-batching`, `sdk-burst`, `streaming-behaviour`                                                                                | `actor-timer`, `frame-envelope`, `fact-bytes`                                                                                                                                              |
| E5.3 persistence                         | `repository`, `persistence`, `records`, `record-cache`, `snapshot`, `append`, `item-metadata`, `schema-version`, `migrations`, `store-generations`, `execution-provenance`, `provider-facts`                                                                                                                                                                                                                         | `repository`, `snapshot`, `records`                         | storage row; `records-write-budget`, `schema-compatibility`, `startup-quarantine`, `cold-state`                                                   | `item-metadata`, `audit-record-cache.process`, `record-budget.process`, `snapshot-retention.process`, `open-text-restart.process`, `snapshot-release.process`, `snapshot-rollback.process` |
| E5.4 commands, intents, queue            | `handler`, `intents`, `queue-store`, `queue-commands`, `create-thread`, `creation-admissions`, `creation-validation`, `input`, `input-journal`, `input-delivery`, `input-fate`, `stale-inputs`, `message-facts`, `person-command`, `title-input`, `thread-posts`, `transcript-inputs`, `ace-inputs`, `ace-input-attribution`, `ace-waits`, `edited-context`, `goal-change`, `guest-admission`, `workspace-directory` | `commands`, `intents`, `queue`, `inputs`                    | commands row (31 files)                                                                                                                           | `edited-context`, `retired-bot-threads`                                                                                                                                                    |
| E5.5 delivery and steering               | `intent-delivery`, `delivery`, `steer-lane`, `steer-selection`, `steer-yield`, `steer-notes`, `turn-origin`, `root-run-start`, `resolution`                                                                                                                                                                                                                                                                          | `delivery`, `steering`                                      | steering row; `submission`, `input-fate`, `input-leases`, `held-send-release`, `resolution`, `interaction-replay`                                 | `steer-yield`, `root-run-start`                                                                                                                                                            |
| E5.6 sessions                            | `sessions`, `provider-sessions`, `session-metadata`, `session-open-route`, `session-fenced`, `resume-open-error`, `provider-errors`, `failure-copy`, `provider-release`, `slot-reclaim`, `background-ports`, `agent-env`, `account-route`, `models`, `selection-notices`, `provider-command-metadata`, `context-meter`, `context-sample`, `silence`, `startup-skip`                                                  | `sessions`, `release`, `models`, `meters`                   | `open-failure`, `provider-release`, `resource-limits`, `model-selection`, `context-meter`, `provider-context-meter`, `socket-liveness`, `silence` | `agent-env`                                                                                                                                                                                |
| E5.7 access and approvals                | `permissions`, `permission-ceiling`, `permission-storage`, `access-defaults`, `ace-approvals`, `interaction-ledger`, `host-threads`, `guest-threads`                                                                                                                                                                                                                                                                 | `access`, `approvals`, `hosts`                              | access row; `execution-approval`, `guest-admission`                                                                                               | `ace-approvals`, `permission-ceiling`                                                                                                                                                      |
| E5.8 recovery and restart                | `recovery`, `restart`, `restart-resume`, `restart-eligibility`, `restart-captures`, `provider-recovery`, `provider-return`, `cursor-reconcile`, `cursor-attempt`, `cursor-empty-migration`, `recover-limited-children`, `lost-work`, `session-bound-tasks`, `imported-thread`                                                                                                                                        | `recovery`, `restart`, `cursor_reconcile`                   | restart row, limits row, Cursor row                                                                                                               | `restart-origin.process`, `cursor-attempt-record`, `restart-ledgers.process`, `session-bound-tasks.process`, `cursor-migration.process`                                                    |
| E5.9 transitions                         | `transitions`, `transition-handler`, `transition-state`, `transition-readiness`, `transition-history`, `switch-admission`, `switch-recovery`, `fork-history`, `fork-replay`, `machine-handoff`, `live-move`, `workspace-change`, `store-handoff`                                                                                                                                                                     | `transitions`, `moves`                                      | transitions row (17 files)                                                                                                                        | none                                                                                                                                                                                       |
| E5.10 liveness, stop, settle, delegation | `thread-liveness`, `settled-trees`, `stop-intents`, `stop-scope`, `snooze-wake`, `delegation-facts`, `child-attachment`, `remote-child-status`, `long-thread-child`                                                                                                                                                                                                                                                  | `liveness`, `settle`, `delegation`                          | stop row; `thread-liveness`; the 56 files outside `engine/` that build an `Engine` (agent-control, machines)                                      | `settled-hold`                                                                                                                                                                             |

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
  after an await stays after that await. Don't hold a `RefCell` borrow across an await or a JS
  call.
- Transactions are `ace_store`'s (`store.atomic`), the same stack TypeScript's `Store.atomic` uses;
  tables, columns, JSON shapes and `engineSchemaVersion` 9 don't change. A home written with the
  switch on must open with it off.
- Measure with `bun apps/daemon/bench/scripted.ts`, `bun apps/daemon/bench/stream-history.ts` and
  `bun apps/daemon/bench/agent-control.ts`, switch off and on.

## When you are done

- Every (a) file of your item passes alone with the switch on and off; your (b) cases pass as
  `cargo test -p <crate>`; `check:daemon-native` passes.
- Report: the files run and their results, the bench figures off and on, any behaviour you found
  no test for (and the one test you added for it, if any), and anything in behaviour.md that turned
  out wrong, with the code that shows it.
