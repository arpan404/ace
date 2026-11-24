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
   missing, fail; never fall back. Ask the switch module at each new instance; it answers with the backend of the current boot of its root, which is how the cross-mode gate flips it (rule 15).
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
8. **Lenient decoding** (ADR 0223 §3). Keep each frame's data as received (`ace_json::Raw`, or
   a borrowed `RawRef` of the frame); match the method or type string, then decode; unknown
   types become an `Unknown` variant with the raw data; unknown fields stay, never
   `deny_unknown_fields`. A translator returns `Vec<Fact>`, never `Result`, and never panics on
   provider data: a failed decode is a `malformed` diagnostic plus a `signal` fact, as the
   TypeScript does.
   **JSON goes through `ace-json`**, never serde_json, in every daemon crate: facts and native
   keys must be byte-identical to what `JSON.parse`/`JSON.stringify` and JavaScript `Map`s
   produce. Its `Value` keeps lone surrogates, JavaScript numbers (`1.0` is an integer, `1e21`
   prints as JavaScript prints it), JavaScript key order and `JSON.parse`'s duplicate-key rule,
   and nothing in it recurses past a bounded depth; `ace_json::ser::to_string` serializes
   derived structs with the same rules. A TypeScript `Map` (or an object iterated in insertion
   order) is an `IndexMap` removed from with `shift_remove`, never a `HashMap`. A value that
   TypeScript ran through a zod `parse` comes out in the schema's key order, not the literal's.
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
    §8) through `scripts/native-cross.ts`, which sets `ACE_NATIVE_CROSS=<your switch>` and a fresh
    `ACE_NATIVE_CROSS_LOG`, runs the file once starting on and once starting off, and then asserts
    from the log that every root (event database or process journal) that booted more than once
    alternated backends from its first boot, and that some root booted twice. A file that never
    reboots a root fails as "no restart" and leaves the list. Same rules as rule 3: one existing
    file at a time, no edits.

    ```sh f=apps/daemon/src/engine/restart-resume.process.test.ts
    test -f "$f" && ACE_STORE=native bun scripts/native-cross.ts ACE_ENGINE "$f"
    ```

16. **Redact the capture, never the wire.** The provider gets the original bytes; the frame you
    build (sent or received) is a redacted copy made before it becomes a payload or leaves your
    task, with the adapter's secrets, and a `send` frame is emitted after its write is handed to
    the transport, in outbound order (behaviour.md §14, "Raw is post-redaction; the wire is not";
    `adapter-pi/src/rpc.ts:70`–`:78`). The raw data you keep is the redacted copy.

## Files per work item

E0 creates every file below as a stub and declares every module, so no two builders edit the same
file. Paths in `native/daemon/crates/`.

| Item              | Rust (yours)                                                                          | Binding (yours)                                                                | TypeScript shell (yours)                                        | Switch                  |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------- |
| E1-codex … E1-pi  | `ace-adapter-<p>/src/translate/`                                                      | `ace-daemon-node/src/translate_<p>.rs`                                         | `packages/adapter-<p>/src/native-translator.ts`                 | `ACE_TRANSLATORS=<p>`   |
| E2a               | `ace-supervisor/src/{spawn,contain,identity,inventory,marker,reaper,stop,listing}.rs` | `ace-daemon-node/src/supervisor.rs`                                            | `packages/provider-kit/src/native-process.ts`                   | `ACE_SUPERVISOR=native` |
| E2b               | `ace-supervisor/src/{lines,budget,flow,jsonrpc,jsonl,sse}.rs`                         | `ace-daemon-node/src/streams.rs`                                               | `packages/provider-kit/src/native-streams.ts`                   | `ACE_SUPERVISOR=native` |
| E3-pi … E3-cursor | `ace-adapter-<p>/src/session/`                                                        | `ace-daemon-node/src/session_<p>.rs`                                           | `packages/adapter-<p>/src/native-session.ts`                    | `ACE_SESSIONS=<p>`      |
| E3.0 (shared)     | `ace-supervisor/src/{divert,peer}.rs`, `ace-adapter-api/src/bridge.rs`                | `ace-daemon-node/src/session_bridge.rs`, `supervisor/child.rs`                 | `packages/provider-kit/src/native-session-bridge.ts`            | `ACE_SESSIONS=<p>`      |
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
  `ACE_NATIVE_CROSS=<switch>`, which selects the backend **per boot of a root** (ADR 0223 §8): a
  boot is the opening of the event database (at the store's connection factory, for `ACE_STORE`,
  `ACE_TRANSLATORS`, `ACE_SESSIONS`, `ACE_ENGINE`) or of the process journal (at
  `ProcessInventory`'s open, for `ACE_SUPERVISOR`); boot _n_ of a root takes the switch's value
  for even _n_ and the opposite for odd _n_; _n_ comes from the append-only log at
  `ACE_NATIVE_CROSS_LOG` (one JSON line per boot: root, _n_, switch, backend, pid), counted under
  an advisory lock so sibling processes count the same boots; `ACE_STORE` and `ACE_SUPERVISOR`
  take a value only at a new process's boot. Translators and sessions created after a boot take
  its backend. A per-instance decision function for each switch, so the shells never read the
  environment themselves. The two boot hooks are one line each, in the connection factory and in
  `ProcessInventory`'s constructor.
- `scripts/native-cross.ts <switch> <file>`: runs the file twice (starting on, starting off) with a
  fresh log each time, then asserts per root from the log (rule 15).
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

## E3: sessions, as builder tasks

A native session runs a provider's process protocol in Rust behind the same `ProviderSession`
(ADR 0223 §7) while the TypeScript engine still runs. The tasks below are the briefs: E3.0 (four
foundations every provider needs), then E3-pi, then E3-codex, then E3-acp, each task one builder
round. OpenCode and Cursor are outlines only, briefed later. Claude has no E3 item: its session
moves in the providers work (ADR 0223, "Decided by the orchestrator").

### Should E3 build now?

The bench (`tools/daemon-bench/results/2026-11-23-rust-switches.md`, branch
`ace/bench-rust-switches`) measured the merged switches 10–23% slower per turn in CPU
(`sameThread` +19.9%, `longText` +22.6% on medians), because values cross between JavaScript and
Rust while both sides run. E3 does not change that figure. The bench's only fake provider is the
`claude` CLI, and Claude has no E3 item, so no native session runs there. The slowdown comes from
the store's per-statement crossings (phase 1a), long reads and the Claude translator, and E3
touches none of them.

What E3 changes is the path of one received frame. Pi is the example; Codex and ACP have the
same shape with JSON-RPC instead of JSONL:

| Switches on                       | Path of one stdout line                                                                                                                                                                                                | N-API crossings                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| none                              | Node reads the pipe; JS frames, redacts, `JSON.parse`s (`ProviderPayload`); the engine runs the TS translator                                                                                                          | 0                                                 |
| `ACE_TRANSLATORS=pi` (E1)         | as above, then `JSON.stringify(frame)` → Rust parse → facts JSON → `JSON.parse` (`adapter-pi/src/native-translator.ts:65`–`:76`)                                                                                       | 2 per frame                                       |
| `+ ACE_SUPERVISOR=native` (E2)    | Rust reads the pipe, posts each chunk to JS (`supervisor/child.rs:47`–`:61`); JS passes it to the Rust framer and gets lines back (`native-framing.ts`); then as above                                                 | 2 per frame + about 3 per 64 KiB chunk            |
| `+ ACE_SESSIONS=pi` (E3, this)    | Rust reads, frames, elides, redacts and inspects the line; frames cross to JS as JSON text once per batch; JS `JSON.parse`s them into `ProviderPayload` as today; the engine's native translator crosses back as in E1 | 2 per frame + 1 per batch of up to 256 frames     |
| `+ ACE_ENGINE=native` (E5, later) | session events go from the session's tokio task to the engine's queue; translation and the fold run in Rust (ADR 0223 §7, "Native both")                                                                               | 0 for the frame; the store's own crossings remain |

So, for each provider:

- **Pi**: E3 removes E2's chunk crossings and the JS framing, redaction and protocol inspection.
  It adds one crossing per batch of frames. The translator's round trip stays. Compared with
  everything off it should come out about even, and compared with E1+E2 it should be a gain. It
  does not remove a crossing per line. Only E5 does that.
- **Codex**: the same, plus the JSON-RPC peer, the shared-host routing and the per-frame session
  bookkeeping (`adapter-codex/src/session.ts:185`–`:353`) leave the JS thread. Codex produces the
  most frames per turn (deltas), so it gains the most from that, and it carries the most risk:
  it is the most used provider and its session is the most entangled (27 session files).
- **ACP**: like Codex, with one agent process per session and no host pool.

The per-batch crossing could be reduced further. A native frame could carry its JSON text, so
that a native translator skips `JSON.stringify`. That saves one serialisation per frame, but
the crossing stays, and it changes `Frame`, so it is not briefed here. Translating inside the
session would change each fact's `now`, and ADR 0223 §8 has translation run wherever the engine
runs, so that is not allowed either.

**Recommendation.** Build E3.0 and E3-pi now, as a pilot. They are small, Pi is the least used
provider, and they prove the bridge, the pipe diversion (E3.0b) and the session bench (E3.0d)
before Codex depends on them. Hold E3-codex and E3-acp until store phase 5's writer and the E5
skeleton (E5.1 to E5.4) are under way. Then build them so that their Rust cores implement
`ace_adapter_api::Session`, and E5.6 drives them with no JavaScript in between. That is when the
crossings disappear. Before it, Codex would carry the most risk and show no gain on the daemon
bench. For performance, the order is: store phase 5 → T2 → T3 (fan-out off the JS thread) and E5
in parallel → E3-codex and E3-acp with E5.6 → T4 → OpenCode and Cursor. A session goes default-on
only when the E3.0d bench is no slower than everything off for its provider, on top of the
ADR 0223 §8 gates (question 2).

### What is merged, and what this plan corrects

Merged on `ace/daemon-rust-rewrite` (`be90ddfc8a`): E0's stubs (`ace-adapter-<p>/src/session.rs`,
`ace-daemon-node/src/session_<p>.rs`, `packages/adapter-<p>/src/native-session.ts`), all six E1
translators, E2a, E2b and E4. Four facts change the E3 table this section replaces:

1. **E2a's supervisor serves primitives only.** Spawning, stop plans, journals, sweeps, the owner
   registry and admission stay TypeScript (`provider-kit/src/native-process.ts:2`–`:9`;
   `process.ts:145`–`:451` drives `nativeSpawnChild`; `process-owner.ts:38`–`:48` holds the
   registry). So a native session does not spawn from Rust. It asks the TypeScript spawn (the
   adapter's `io.spawn`, which tests inject) for a native child whose piped output and stdin are
   **diverted** to the Rust session from birth (E3.0b). That way ownership, the stop plan,
   inventory, priority and the tests' spawn wrappers stay exactly today's.
2. **E2b ported only halves of JSON-RPC**: ids, the writer queue and envelope classification
   (`native-rpc.ts:1`–`:3`, `ace-supervisor/src/jsonrpc.rs`). The peer itself (`jsonrpc.ts:129`,
   365 lines: pending requests, timeouts, server requests, method-not-found) is TypeScript. Codex
   and ACP need a Rust peer (E3-codex.1, which ACP reuses).
3. **`extension-mcp.ts` runs inside Pi**: only `extension.ts` imports it, and Pi loads that with
   `-e` (`adapter-pi/src/session.ts:96`–`:98`). It stays TypeScript, so `rmcp` leaves
   `ace-adapter-pi/Cargo.toml` (E3-pi.1), and its (b) file stays.
4. **ACP uses ace's own peer**, and the SDK only for `AGENT_METHODS` and `PROTOCOL_VERSION`
   (`adapter-acp/src/session.ts:31`, `:384`). The Rust session uses the E3-codex.1 peer, so
   budgets, dropped lines and the redacted capture stay ace's. `agent-client-protocol` (already in
   `ace-adapter-acp/Cargo.toml:21`) is used for nothing beyond those two constants, or removed
   (question 3).

Two more facts shape every task:

- **The addon has no async exports** (`ace-daemon-node/Cargo.toml:49`: `napi9`, no `tokio_rt`).
  Every promise a facade returns is a JavaScript promise, settled by an event on the session's
  ordered queue (rule 3). That is also what rule 3 requires: a reply never overtakes the frame
  that carried it (today Pi emits the `recv` frame before it resolves the request,
  `adapter-pi/src/rpc.ts:51`–`:61`).
- **Time, ids and secrets come from the adapter's injected runtime**, which tests replace
  (`adapter-pi/src/testing/harness.ts:112`–`:129`: `now: () => 0`, counted secrets, manual
  timers that `expireDialogs()` fires). So a native session never sets a tokio timer for
  protocol deadlines. It asks the facade to arm one (an event), the facade calls the injected
  `schedule`, and the timer calls back into the handle. Frame `t` is stamped by the bridge at
  delivery from the injected `now`: it can be later than the read by one batch, never earlier.

### Rules for every E3 task

The engine guide's rules 1–16 apply, plus these:

- **Who writes the code.** The owner's rule (2026-11-23): Opus plans and reviews, DeepSeek Flash
  or Muse writes the code, each from one brief (the task's section copied whole, plus these
  rules), and Codex reviews the code. A builder that finds the brief wrong or incomplete stops and
  reports. It never fills a gap with its own design.
- **Branches.** From `ace/daemon-rust-rewrite`, one per task: `ace/rust-engine-e3-<task>` (for
  example `ace/rust-engine-e3-pi-1`). Merge `origin/ace/daemon-rust-rewrite` in, never rebase.
- **Load limits.** `CARGO_BUILD_JOBS=4`, `--maxWorkers=4`, one test file at a time, one bench at
  a time, no full suite.
- **The bridge's five rules** (ADR 0223 §7) are the contract. In E3 the engine is TypeScript, so
  rule 1 takes this form: preparation that awaits happens first; then, in one synchronous
  JavaScript turn, `assertSteerTarget(delivery, fence)` runs and the facade makes one synchronous
  binding call that, under the session's state lock, checks the turn the session last saw and
  pushes the original bytes onto the stdin port. Nothing awaits between the two. A full queue
  refuses there with today's error.
- **Off by default, and the off path is untouched.** With `ACE_SESSIONS` unset, no byte of
  behaviour changes. The TypeScript session code stays until one release after default-on
  (ADR 0223 §8).

Commands every task uses (from the repository root):

```sh
# Rust
(cd native/daemon && PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH \
  CARGO_BUILD_JOBS=4 cargo fmt --all --check \
  && CARGO_BUILD_JOBS=4 cargo clippy --workspace --all-targets --locked \
  && CARGO_BUILD_JOBS=4 cargo test -p <crate> --locked \
  && cargo deny check bans licenses sources \
  && CARGO_BUILD_JOBS=4 cargo build --release --locked -p ace-daemon-node)
bun run check:daemon-native
# TypeScript
bun run fmt:check && bun run lint && bun run typecheck
# One file, off then on (never an empty path: that runs everything)
A=$PWD/native/daemon/target/release/libace_daemon_node.dylib
f=packages/adapter-pi/src/session.process.test.ts
test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
test -f "$f" && ACE_STORE=native ACE_SUPERVISOR=native ACE_SESSIONS=pi \
  ACE_STORE_ADDON=$A ACE_SUPERVISOR_ADDON=$A ACE_SESSIONS_ADDON=$A \
  bun --bun x vitest run "$f" --maxWorkers=4
# Also with the provider's translator native
test -f "$f" && ACE_STORE=native ACE_SUPERVISOR=native ACE_SESSIONS=pi ACE_TRANSLATORS=pi \
  ACE_STORE_ADDON=$A ACE_SUPERVISOR_ADDON=$A ACE_SESSIONS_ADDON=$A ACE_TRANSLATORS_ADDON=$A \
  bun --bun x vitest run "$f" --maxWorkers=4
```

A session (a) file passes in all three modes. The engine files a task names run in the same three
modes.

### E3.0 Foundations (one builder each, in order; needs E2a, E2b; no provider behaviour)

#### E3.0a The switch's needs and its addon

- **Files**: `packages/provider-kit/src/native-switches.ts`, `native-switches.test.ts`;
  `tools/daemon-bench/src/daemon.ts` (the `ACE_SESSIONS` row, `:60`–`:64`);
  `scripts/test-home-policy.ts` (`:121`, beside `ACE_SESSIONS`). Nothing else.
- **What changes**:
  - Export a pure
    `sessionSwitchRefusal(input: { sessions: readonly string[]; store: boolean; supervisor: boolean; cross: CrossSwitch | undefined }): string | undefined`.
    It returns, in this order: `"ACE_SESSIONS needs ACE_STORE=native"` when sessions are named
    (or `cross` is `ACE_SESSIONS`) and `store` is false (today's message); then
    `"ACE_SESSIONS needs ACE_SUPERVISOR=native"` when sessions are named (or `cross` is
    `ACE_SESSIONS`) and `supervisor` is false; then
    `"ACE_NATIVE_CROSS=ACE_SUPERVISOR cannot run with ACE_SESSIONS"` when sessions are named and
    `cross` is `ACE_SUPERVISOR` (a boot with the TypeScript supervisor could not divert a pipe).
    The module calls it at load and throws its message. The `offender` chain for `ACE_SUPERVISOR`
    and `ACE_ENGINE` (`:105`–`:115`) keeps its messages.
  - Export `sessionsAddonPath(): string`: `ACE_SESSIONS_ADDON`, else `ACE_STORE_ADDON`, else the
    development path the other shells use (`../../../native/daemon/target/release/<library>`,
    resolved from the module's URL). The shells load the addon through this. With a session on
    and no file there, loading throws naming the path. It never falls back.
  - The bench row becomes
    `{ variable: "ACE_SESSIONS", addons: ["ACE_SESSIONS_ADDON", "ACE_SUPERVISOR_ADDON"] }`, and
    the bench refuses `ACE_SESSIONS` without `ACE_SUPERVISOR=native` in its own environment.
    `test-home-policy.ts` keeps `ACE_SESSIONS_ADDON` and `ACE_SUPERVISOR_ADDON`.
- **Tests**: add one `test.each` table to `native-switches.test.ts` over
  `sessionSwitchRefusal` (each refusal, the order when two apply, and no sessions → undefined).
  It is new behaviour, so the commit says so. Then, off,
  `bun --bun x vitest run packages/provider-kit/src/native-switches.test.ts --maxWorkers=4`.
- **Must not**: change any other switch's parsing or messages; read the environment anywhere
  else.
- **Reviewer checks**: `ACE_STORE=native ACE_SESSIONS=pi bun -e 'await import("@ace/provider-kit/native-switches")'`
  throws the supervisor message; the table test fails if the order of the checks changes.

#### E3.0b Diverting a native child's pipes to a Rust consumer

- **Files**: create `native/daemon/crates/ace-supervisor/src/divert.rs` (and `pub mod divert;`
  in `lib.rs`); change `ace-supervisor/src/child/mod.rs` (a `stdin_port` accessor),
  `ace-daemon-node/src/supervisor/child.rs` (`supervisor_spawn`, `:146`),
  `packages/provider-kit/src/native-process.ts` (`nativeSpawnChild`), and
  `packages/provider-kit/src/process.ts` (`SpawnOptions`, `:85`; the native branch of
  `spawnOwned`, `:185`–`:197`). Nothing else.
- **Types** (`divert.rs`):

  ```rust
  /// A Rust consumer of a child's piped output and stdin acknowledgements, fixed at spawn.
  pub trait OutputConsumer: Send + Sync + 'static {
      fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered);
      fn end(&self, stream: OutputStream);
      fn stdin_written(&self);
      fn stdin_error(&self, error: NodeIoError);
      /// The leader's end (node's `exit`), then the pipes' (node's `close`).
      fn exit(&self, exit: RawExit);
      fn close(&self, exit: RawExit);
  }
  /// What a session hands to the spawn: its consumer, and the slot the spawn fills with stdin.
  pub struct DivertTarget {
      pub consumer: Arc<dyn OutputConsumer>,
      pub stdin: Arc<std::sync::OnceLock<StdinPort>>,
  }
  /// Writes into the child's stdin queue, in order with every other write.
  #[derive(Clone)] pub struct StdinPort { /* UnboundedSender<StdinMessage> */ }
  impl StdinPort { pub fn write(&self, bytes: Vec<u8>) -> Result<(), SupervisorError>;
                   pub fn end(&self) -> Result<(), SupervisorError>; }
  /// The sink a diverted child is spawned with.
  pub struct Diverted<E: EventSink> { shell: E, target: Arc<dyn OutputConsumer> }
  ```

  Routing of `impl EventSink for Diverted`, exactly:

  | Event                          | To the consumer | To the shell (JS)                     |
  | ------------------------------ | --------------- | ------------------------------------- |
  | `output`                       | yes             | no                                    |
  | `end`                          | yes, first      | yes, after (the JS stream ends empty) |
  | `exit`, `close`                | yes, first      | yes, after                            |
  | `stdin_written`, `stdin_error` | yes             | no                                    |
  | `hold_limit`, `held`           | no              | yes                                   |

- **Binding**: a `#[napi] pub struct NativeOutputTarget` that holds a `DivertTarget`. It is
  built only by the session bindings (E3-pi.2 and later), never from JS data.
  `supervisor_spawn(spec_json, events, target: Option<&NativeOutputTarget>)`: with a target, it
  spawns with `Diverted { shell: TsfnSink, target }` and fills `target.stdin` with the child's
  port before returning. `NativeChild.writeStdin` on a diverted child throws
  `"stdin is owned by the native session"`. `endStdin` still works, because the Windows stop ends
  stdin (`adapter-pi/src/session.ts:61`–`:67`).
- **TypeScript**: `SpawnOptions` gains `nativeOutput?: NativeOutputTarget` (an opaque type
  exported from `native-process.ts`). `spawnOwned` passes it to `nativeSpawnChild`. With the
  TypeScript backend and `nativeOutput` set, it throws
  `"nativeOutput needs ACE_SUPERVISOR=native"` before spawning. Nothing else in `spawnOwned`
  changes. The diverted child's `stdout` and `stderr` Readables carry no data and end on their
  `*-end` events, so the line limit and elision transforms see nothing.
- **Tests**: a `#[cfg(test)]` table in `divert.rs` over the routing table above, with a
  recording consumer and a recording shell. It is new behaviour, so the commit says so. Off and
  with `ACE_SUPERVISOR=native`: `provider-kit/src/process.process.test.ts`,
  `fast-exit.process.test.ts`, `process-stop.process.test.ts`, each alone. They must not change,
  since nothing diverts yet.
- **Must not**: change any undiverted event, the stop plan, inventory or registry calls; add a
  dependency.
- **Reviewer checks**: the routing matches the table cell by cell; an undiverted spawn's code path
  is byte-identical (diff `spawnOwned`); no `unwrap`.

#### E3.0c The session bridge (shared by every native session)

- **Files**: create `native/daemon/crates/ace-adapter-api/src/bridge.rs` (`pub mod bridge;`;
  `ace-adapter-api/Cargo.toml` gains `tokio` with `sync` only, with a comment saying why);
  `native/daemon/crates/ace-daemon-node/src/session_bridge.rs` (and its `mod` line);
  `packages/provider-kit/src/native-session-bridge.ts` (new, exported from
  `@ace/provider-kit/native-session-bridge` in `package.json`).
- **Rust types** (`bridge.rs`): the queue and flow gate every session uses.

  ```rust
  pub enum SessionEvent {
      /// `text` is the redacted JSON text of the frame's data; seq is assigned here, in push order.
      Frame { seq: u64, dir: FrameDir, channel: String, text: String },
      /// One context callback, by name (`onSessionIdentity`, `onSessionConfirmed`, ...), JSON args.
      Callback { name: &'static str, json: String },
      /// Settles the facade's promise `id`: `Ok(json)` or `Err(SessionErrorWire)`.
      Settle { id: u64, result: Result<String, SessionErrorWire> },
      ArmTimer { key: String, ms: f64 },
      CancelTimer { key: String },
      /// The session cannot go on: the facade closes it, unexpected (as `fatal()` does today).
      Fatal { message: String },
      /// Last event: every frame before it was pushed. Nothing follows.
      Drained,
  }
  pub struct SessionErrorWire { pub code: &'static str, pub message: String } // see below
  pub struct EventQueue { /* Mutex<VecDeque<SessionEvent>>, a wake callback, a closed flag */ }
  impl EventQueue {
      pub fn push(&self, event: SessionEvent);       // after Drained: dropped and logged, never panics
      pub fn frame(&self, dir: FrameDir, channel: &str, text: String); // assigns seq
      pub fn take_batch(&self, max_frames: usize, max_bytes: usize) -> Vec<SessionEvent>;
  }
  /// The mirrored `outputFlow` flag (ADR 0223 §7 rule 4). Readers wait while paused, unless
  /// `cancelled` (then they read to EOF within the output budget).
  pub struct ReadGate { /* AtomicBool paused, AtomicBool failed, AtomicBool cancelled, Notify */ }
  impl ReadGate { pub fn set_paused(&self, paused: bool); pub fn fail(&self); pub fn cancel(&self);
                  pub async fn wait_readable(&self) -> Readable; } // Readable::{Go, Failed}
  ```

  The error codes are fixed strings: `ACE_STEER_TARGET_LOST`, `ACE_INPUT_REJECTED`, and one per
  provider-defined refusal (`ACE_PI_COMMAND_REFUSED`, ...), named in each provider's task.

- **Binding** (`session_bridge.rs`): `SessionPort`, one per native session. It holds one
  `ThreadsafeFunction<String, ()>` and the `EventQueue`. A push wakes the port, which posts at
  most one call at a time (the same single-claim rule as ADR 0223 §4). The call carries one
  batch, at most 256 frames or 256 KiB of frame text, encoded with `ace_json::ser::to_string` as
  `[[kind, ...fields], ...]`. The function stays referenced until `Drained` has been delivered,
  then it is released. `#[napi] fn set_paused(&self, paused: bool)`, `fail()`, `cancel()`.
- **TypeScript** (`native-session-bridge.ts`):

  ```ts
  export interface NativeSessionPort {
    setPaused(paused: boolean): void;
    fail(): void;
    cancel(): void;
  }
  export interface BridgeHooks {
    now(): number; // the adapter's injected clock
    started: number;
    schedule(callback: () => void, ms: number): () => void; // the adapter's injected timer
    timer(key: string): void; // calls the handle back when an armed timer fires
    fatal(message: string): void; // the facade's close("shutdown", false)
    drained(): void; // the facade's exit path
  }
  /** Delivers one batch, in order. Owns the facade's pending promises by id. */
  export function sessionBridge(
    ctx: SessionContext,
    port: NativeSessionPort,
    hooks: BridgeHooks,
  ): {
    deliver(batch: string): void; // the threadsafe function's callback
    expect(id: number): Promise<unknown>; // a promise settled by a Settle event
  };
  export function mapSessionError(error: { code: string; message: string }): Error;
  ```

  `deliver` parses the batch and handles each event in order. A `Frame` becomes
  `new ProviderPayload(text)` and
  `ctx.onFrame({ seq, t: Math.max(0, Math.round(hooks.now() - hooks.started)), dir, channel, data: payload.data, payload })`.
  If the returned value is a promise that rejects, the bridge calls `port.fail()`, as
  `engine/sessions.ts:684`–`:699` stops intake. After each frame, if `ctx.outputFlow?.paused()`,
  it calls `port.setPaused(true)` once and `port.setPaused(false)` when `outputFlow.wait()`
  resolves. A `Callback` calls `ctx[name]?.(...JSON.parse(json))`. A `Settle` resolves or rejects
  the promise from `expect(id)`, with `mapSessionError`: `ACE_STEER_TARGET_LOST` →
  `new SteerTargetLost(message)`, `ACE_INPUT_REJECTED` → `new InputRejected(message)`, a provider
  code → that adapter's error class, which the facade registers. `ArmTimer` and `CancelTimer`
  call `hooks.schedule` and the cancel it returned, keyed. `Fatal` calls `hooks.fatal`.
  `Drained` calls `hooks.drained`, then cancels every armed timer. A promise still pending at
  `Drained` rejects with `Error("session closed")`.

- **Tests**: none new. E3-pi.2's files prove it. **Bench**: none.
- **Must not**: deliver a frame, settle or exit through any other path (rule 3); `await` inside
  `deliver`; build the `Frame` anywhere but here.
- **Reviewer checks**: one threadsafe function per session; at most one call in flight; release
  only after `Drained`; batch bounds 256/256 KiB; `t` is stamped from the injected `now`.

#### E3.0d The session bench

- **Files**: create `apps/daemon/bench/session-stream.ts` and its fakes under
  `apps/daemon/bench/session-stream/` (`pi.ts` first; E3-codex.5 and E3-acp.3 add `codex.ts` and
  `acp.ts`).
- **What it does**: through `createPiAdapter().openSession(ctx)` with an `io.spawn` that runs the
  bench's fake (as `adapter-pi/src/testing/harness.ts:120`–`:128` runs `fake-pi.ts`). The fake
  answers the open handshake as `testing/fake-pi.ts` does (`get_commands`, `get_state`), then,
  on one `prompt`, prints a turn of 2,000 `message_update` lines, a `message_end` and an `agent_end` (the shapes
  `translator.ts:162`–`:205` reads), ten times. `ctx.onFrame` runs the adapter's translator on each frame, as the engine does, and
  returns a resolved promise. Each run records `process.cpuUsage()` per 1,000 frames, frames per
  second, and `heapUsed` after two forced GCs, and writes JSON to `--output`.
- **Modes**, one run each, alternating, three rounds: off; `ACE_TRANSLATORS=pi`; that plus
  `ACE_SUPERVISOR=native`; that plus `ACE_SESSIONS=pi` (with `ACE_STORE=native` where required). The
  last mode runs once E3-pi.2 has merged; until then the bench refuses it.
- **Must not**: spend quota, start a real CLI, or run beside another bench.
- **Reviewer checks**: the on modes prove the native path, because the run fails if the addon is
  missing; the fake's frames are real Pi shapes (copied from `fake-pi.ts`).

### E3-pi: Pi (JSONL over stdio, one process per session)

The split for Pi: Rust takes everything that runs per line or per write. That is `rpc.ts` whole,
and the half of `session.ts` that inspects frames, tracks dialogs, redacts, frames stdout and
stderr and drains on exit. The facade keeps the open-time and control composition in TypeScript:
discovery, MCP configuration, session references, launch arguments, `verifyExtension`,
`restore`, `fork`, `rollback`, and `send` and `interrupt` as sequences of `request`s. That
composition reads no per-frame state between a check and its write. So rule 1 holds with the
TypeScript check followed by a synchronous `request`, as today (`session.ts:404`–`:410`,
`rpc.ts:80`–`:88`). It also keeps the session-reference files (`session-references.ts`) written by
one implementation, which makes cross-mode resume safe by construction. E3-pi.3 moves the
composition to Rust with E5.

#### E3-pi.1 The Pi wire core in Rust (sans-IO)

- **Files**: create `native/daemon/crates/ace-adapter-pi/src/session/{mod.rs,wire.rs,dialogs.rs,redact.rs,error.rs}`;
  delete `src/session.rs` (the E0 stub) and declare `pub mod session;` from the directory;
  `Cargo.toml`: remove `rmcp` (fact 3 above), add nothing.
- **Ports**: `adapter-pi/src/rpc.ts` whole (`PiRpc`, `:12`–`:124`); from `session.ts`, the
  redaction (`:129`–`:133`), the `recv` inspection (`:217`–`:259`: rollback acknowledgement,
  dialog tracking with its timeout, `fatal` on an unparseable blocking dialog), dialog expiry
  (`:195`–`:202`), the stderr line path (`:135`–`:138`, `:261`–`:265`), and the drain
  (`:266`–`:283`); the `Response`, `Dialog` and `isBlockingDialogMethod` shapes from `native.ts`
  (`:14`–`:42`), as `ace-json` lookups, not serde structs.
- **Types**:

  ```rust
  pub struct PiWireConfig { pub control_secret: String, pub lease_bearer: Option<String> }
  pub enum PiError { Refused(String), TimedOut, Mismatch, Closed, FrameLimit } // Display = today's messages
  /// Everything the session does in reaction to one input, in order.
  pub enum Effect {
      Frame { dir: FrameDir, channel: &'static str, text: String }, // already redacted
      Write { wire: Vec<u8>, ticket: u64 },                        // original bytes + "\n"
      Settle { id: u64, result: Result<String, PiError> },
      ArmTimer { key: String, ms: f64 }, CancelTimer { key: String },
      Fatal { message: String },
      Drained,
  }
  pub struct PiWire { /* pending: IndexMap<String, Pending> (max 64), writer: WriterQueue (2 MiB),
                         dialogs: IndexMap<String, (Raw, Option<timer key>)>, waiting_on_human,
                         rollback: Option<(String, Option<bool>)>, closed, stderr DroppedNotes */ }
  impl PiWire {
      pub fn new(config: PiWireConfig) -> PiWire;
      /// rpc.request: refuses closed, 64 pending, 1 MiB; reserves "ace-<n>", arms the 30 s deadline
      /// unless waiting on a person; returns the facade's promise id and the Write effect.
      pub fn request(&mut self, command: &str, params: &ace_json::Map, id: u64) -> Result<Vec<Effect>, PiError>;
      /// rpc.write (dialog answers): same limits, no correlation.
      pub fn write(&mut self, data: &ace_json::Map, id: u64) -> Result<Vec<Effect>, PiError>;
      pub fn written(&mut self, ticket: u64) -> Vec<Effect>;        // emits the redacted send Frame
      pub fn stdout_line(&mut self, line: &str) -> Vec<Effect>;      // after framing and elision
      pub fn stderr_line(&mut self, line: &str) -> Vec<Effect>;
      pub fn stderr_dropped(&mut self, line: DroppedLine) -> Vec<Effect>;
      pub fn timer(&mut self, key: &str) -> Vec<Effect>;            // deadline, dialog, drain, note
      pub fn note(&mut self, json: &str) -> Vec<Effect>;            // facade's lifecycle notes
      pub fn take_dialog(&mut self, id: &str) -> Option<ace_json::Value>; // resolve()'s reservation
      pub fn expect_rollback(&mut self, id: String);
      pub fn rollback_result(&mut self) -> Option<bool>;
      pub fn exited(&mut self) -> Vec<Effect>;                       // arms the 1 s drain
      pub fn stderr_ended(&mut self) -> Vec<Effect>;                 // flushes notes, Drained
      pub fn close(&mut self) -> Vec<Effect>;                        // rejects pending: "Pi RPC closed"
  }
  ```

- **Semantics to keep, statement by statement**: the order inside `readJsonLines`' callback
  (`rpc.ts:44`–`:66`): redact, then the `recv` frame, then correlation, then settle; the send
  frame only after the write is acknowledged (`:76`–`:78`); the mismatch message (`:59`);
  `pauseDeadlines` on a new dialog cancels every pending deadline, and `resumeDeadlines` re-arms
  them only once no dialog is left (`:95`–`:103`). A command that times out rejects with
  `"Pi command timed out; execution uncertain"` and then fails the session (`:104`–`:113`). The
  stderr path is redacted, empty lines are skipped (`session.ts:262`–`:264`), and there is at
  most one drop note a second, through the `note` timer.
- **Framing**: stdout is `ace_adapter_api::util::elision` (hold 16 KiB, text 1 MiB,
  `session.ts:151`), then `ace_supervisor::jsonl::JsonLines::new(1 MiB)`; stderr is
  `ace_supervisor::budget::DroppingGate::new(1 MiB)`. Lines are framed on CR and LF, as
  `lineReader`. These are today's numbers (rule 10).
- **Tests**: none new; E3-pi.2's files prove it. `cargo test -p ace-adapter-pi` still passes
  (E1's cases).
- **Must not**: spawn, read the clock, set a timer, or touch the filesystem; use `serde_json`;
  change `translate/`.
- **Reviewer checks**: diff each `PiWire` method against its TypeScript lines above; every error
  message is today's string; redaction happens before any `Frame` effect, and `Write` carries the
  original.

#### E3-pi.2 The Pi binding, facade and switch

- **Files**: `native/daemon/crates/ace-adapter-pi/src/session/io.rs` (new: the tokio side),
  `ace-daemon-node/src/session_pi.rs`, `packages/adapter-pi/src/native-session.ts`,
  `packages/adapter-pi/src/session.ts` (one line, below). Nothing else.
- **Rust I/O** (`io.rs`): `PiSessionCore` holds `Mutex<PiWire>`, the `EventQueue`, the
  `ReadGate` and the `DivertTarget`. As `OutputConsumer`: stdout and stderr bytes go through
  their framers into `PiWire`, and the effects are applied in order. `Write` goes to the stdin
  port. `Frame`, `Settle`, `ArmTimer`, `CancelTimer`, `Fatal` and `Drained` are pushed onto the
  queue. `Delivered::taken(more)` is answered with `more = !gate.paused()`, and a paused reader
  is resumed when the gate clears, unless `cancelled`, in which case it reads to EOF (rule 4).
  `exit` calls `PiWire::exited`, and `end(Stderr)` calls `stderr_ended`.
- **Binding** (`session_pi.rs`):

  ```rust
  #[napi] pub struct PiSessionNative { core: Arc<PiSessionCore>, port: SessionPort }
  #[napi] impl PiSessionNative {
      #[napi(constructor)] pub fn new(config_json: String, events: ThreadsafeFunction<String, ()>) -> napi::Result<Self>;
      #[napi] pub fn output_target(&self) -> NativeOutputTarget;
      #[napi] pub fn request(&self, command: String, params_json: String, id: u32) -> napi::Result<()>; // throws ACE_PI_COMMAND_REFUSED
      #[napi] pub fn write(&self, data_json: String, id: u32) -> napi::Result<()>;
      #[napi] pub fn note(&self, json: String);
      #[napi] pub fn timer(&self, key: String);
      #[napi] pub fn take_dialog(&self, id: String) -> Option<String>;
      #[napi] pub fn expect_rollback(&self, id: String);
      #[napi] pub fn rollback_result(&self) -> Option<bool>;
      #[napi] pub fn close_wire(&self);
      #[napi] pub fn set_paused(&self, paused: bool); #[napi] pub fn fail(&self); #[napi] pub fn cancel(&self);
  }
  ```

  Every export uses `catch_unwind`. JSON crosses only as text (store guide, rule on lone
  surrogates).

- **Facade** (`native-session.ts`): `export async function openNativePiSession(ctx, options): Promise<PiSession>`.
  It is `openPiSession` (`session.ts:55`–`:505`) with these, and only these, replacements:
  - `rpc` is a local object with `request(command, params)`, which allocates `id`, calls
    `handle.request` synchronously (a throw becomes `Promise.reject(new PiCommandRefused(message))`)
    and returns `bridge.expect(id)`; `write(data)` likewise; `pauseDeadlines`, `resumeDeadlines`
    and `close` go to the handle. No other code changes shape.
  - `io.spawn({...same options..., nativeOutput: handle.outputTarget()})`. The `maxLineBytes`,
    `elideStdout` and `onStderrLineDropped` options stay in the call. They take no effect on a
    diverted child, and the Rust framers apply the same numbers.
  - `emit` and `note` call `handle.note(JSON.stringify(...))`. The facade never calls
    `ctx.onFrame`; the bridge does.
  - The `PiRpc` constructor's frame callback (`:217`–`:259`) and `stderrLines`
    (`:261`–`:265`) are gone, because Rust does both. `dialogs` becomes `handle.takeDialog`.
    `rollbackAck` becomes `handle.expectRollback` and `handle.rollbackResult`.
  - The drain (`:266`–`:283`) and `onExit` (`:311`–`:317`) become `hooks.drained`, which awaits
    `proc.exited` and then calls `ctx.onExit({ deliberate, message: \`Pi process ${exit.reason}, code ${exit.code}\` })`.
    That is the last event.
  - `hooks.fatal` is today's `fatal` (`:214`–`:216`). The `proc.exited` handler (`:304`–`:310`)
    also calls `handle.closeWire()`.
  - Register `PiCommandRefused` for `ACE_PI_COMMAND_REFUSED` with the bridge.
  - The switch, the one line in `session.ts`, first statement of `openPiSession`:
    `if (sessionBackend("pi") === "native") return (await import("./native-session.ts")).openNativePiSession(ctx, options);`
- **Invariants** (behaviour.md): §8 identity before echo (Pi has no `onSessionIdentity`; the
  reference is saved before `openPiSession` returns, as today); exit behind frames (rule 3); §10
  check and admission in one step; §12 stop plan (`proc.stop({ graceMs: 1000 })`, the Windows
  `stopTreeAfterEof`, both still TypeScript); §14 raw is post-redaction, so the control secret
  and lease bearer never reach a frame; §15 the child is owned, journaled and stopped by
  TypeScript as today.
- **Proof** (each alone, in the three modes): `packages/adapter-pi/src/` `session.process`,
  `catalog-input.process`, `delegation-context.process`, `fork.process`, `history.process`,
  `input-rejected.process`, `permissions.process`, `shim-session.process`, `skills.process`,
  `system-prompt.process`, `tool-exposure.process`, `tool-listing.process`,
  `extension.process`; then `apps/daemon/src/engine/` `adapter-echo.process`,
  `attachment-echo.process`, `provider-context-meter.process`, `provider-permissions.process`,
  and `apps/daemon/src/provider-availability.process.test.ts`,
  `provider-mcp.process.test.ts`, each with `ACE_SESSIONS=pi`.
- **Cross-mode** (ADR 0223 §8): no existing file reboots a home with a Pi thread, so the gate has
  nothing to run for Pi (question 1 below). The reference files stay written by TypeScript in
  both modes, so a rollback cannot misread them.
- **Bench**: `bun apps/daemon/bench/session-stream.ts` in its four modes. Report all four.
- **Must not**: change `session.ts` beyond the one line; edit any test or `testing/` file; move
  `extension.ts`, `extension-api.ts` or `extension-mcp.ts`; set a Rust timer.
- **Reviewer checks**: a hunk-by-hunk diff of `native-session.ts` against `session.ts` shows only
  the replacements above; `ProviderSession` timing is unchanged (`close` still resolves on
  confirmed exit); no frame is built outside the bridge; the files pass in all three modes.

#### E3-pi.3 The Pi control in Rust (build with E5.6, not before)

Port the open and control composition so the Rust engine opens Pi without JavaScript:
`openPiSession`'s preparation (`session.ts:59`–`:127`), `verifyExtension`, `restore`, `idle`,
`savedNativeReference`, `send`, `interrupt`, `resolve`, `fork`, `rollback`
(`:169`–`:505`), `fork.ts`, `input.ts`, `launch-args.ts` (its (b) cases move to
`#[cfg(test)]`), `session-header.ts`, `session-references.ts` (the same file format, byte for
byte), `fork-admission.ts`, `history-errors.ts`, as `impl ace_adapter_api::Session for PiSession`.
Discovery and `privateMcpConfig` come through the engine's ports. It is briefed in full when E5.6
is, because its ports are E5.6's.

### E3-codex: Codex (JSON-RPC over stdio, a shared app-server per account)

Codex moves whole, because its steer check reads per-frame state: `sendTo` compares `fence.turn`
with `active.get(threadId)` (`session-commands.ts:93`–`:95`), and `active` changes with every
turn frame. So the check, the turn lookup and the enqueue must sit under one lock in Rust, and the
control composition comes too. The TypeScript that stays is `account-login.ts` and `usage-read.ts`
(not session code), `native.ts` (key helpers the tests import, behaviour.md §19), the `testing/`
fakes, and everything the E1 translator owns. Five tasks, in order.

#### E3-codex.1 The JSON-RPC peer in Rust (shared with ACP and the Cursor host)

- **Files**: create `native/daemon/crates/ace-supervisor/src/peer.rs` (`pub mod peer;`). Nothing
  else.
- **Ports**: `provider-kit/src/jsonrpc.ts` (`JsonRpcPeer`, `:129`–`:365`), `rpc-owner.ts`,
  `rpc-timers.ts`, over the merged halves (`jsonrpc.rs`: `RpcIds`, `WriterQueue`, `inspect`,
  `error_code`).
- **Shape**: sans-IO, like `PiWire`. `RpcPeer::new(PeerConfig { timeout_ms, max_pending, max_queued_bytes })`;
  `request(method, params: &ace_json::Value, id: u64, timeout: Option<f64>) -> Result<Vec<PeerEffect>, PeerError>`;
  `notify`; `answer(server_id, result)`; `answer_error(server_id, code, message)`;
  `line(&str) -> Vec<PeerEffect>`; `written(ticket)`; `timer(key)`; `close(reason)`.
  `PeerEffect` is `Frame{dir, value}` (unredacted: the session redacts), `Write{wire, ticket}`,
  `Settle{id, result}`, `ServerRequest{id, method, params}`,
  `Notification{method, params}`, `Malformed{line}`, `ArmTimer`, `CancelTimer`, `Failed{message}`.
  Method-not-found replies, the pending bound and the timeout messages are `jsonrpc.ts`'s strings.
  Order: a `recv` frame precedes the effect it causes, as `onFrame` precedes dispatch today.
- **Tests**: none new. E3-codex.5 and E3-acp.3 prove it through their session files.
- **Must not**: use `jsonrpsee` (ADR 0223 §2) or `agent-client-protocol`'s connection; read a
  clock.
- **Reviewer checks**: each `jsonrpc.ts` branch has its effect; error messages compared string by
  string.

#### E3-codex.2 The host, its router and the pool

- **Files**: `native/daemon/crates/ace-adapter-codex/src/session/{mod.rs,host.rs,routing.rs,pool.rs,lease.rs,app_server.rs}`
  (delete the `session.rs` stub).
- **Ports**: `host.ts` (`CodexHost`, `:193`–`:690`: tenants, holds, init frames replayed to each
  tenant, `#own` requests, retirement), `host-routing.ts` (`HostRouter`, `:45`–`:173`, with
  `subjectThread` and `revealedChildren`), `host-pool.ts` (`CodexHostPool`, `:34`–`:168`, the
  10-minute idle (`defaultHostIdleMs`, `:11`), `openChannel`, `:159`), `thread-lease.ts`
  (`holdCodexThread`, `:32`), `app-server.ts` (`openAppServer`, `:29`). Each host is one diverted
  child (E3.0b) and one `RpcPeer`. A tenant is a session's channel with its own `EventQueue`; a
  host fans each routed frame out to its owner's queue only, and init frames to every tenant that
  attaches.
- **The pool's identity**: a native pool is created per TypeScript `CodexHostPool` instance (a
  `WeakMap` in the facade, E3-codex.5), so the tests that share one pool share one native pool.
  `CodexHostPool.close()` also closes its native twin. That is a one-line change in
  `host-pool.ts:44`–`:46`, made in E3-codex.5.
- **(b) cases to move**: `shared-host.process`, `thread-lease.process`, `host-retire`, as
  `#[cfg(test)]` in `pool.rs`, `lease.rs` and `host.rs` (behaviour.md §19). They spawn the same
  fake app-server (`adapter-codex/src/testing/shared-cli.ts`) with `bun` from `PATH`; a missing
  `bun` fails the test, it never skips. Same cases, same expectations, none added.
- **Must not**: spawn without diversion; let one tenant's frames reach another's queue.
- **Reviewer checks**: the routing table (`received`, `:113`–`:153`) is ported branch for branch;
  retirement reasons are `host.ts:49`'s set.

#### E3-codex.3 The session's per-frame state and capture

- **Files**: `ace-adapter-codex/src/session/{state.rs,frames.rs,discovery.rs,lifetime.rs,dropped.rs,tools.rs,terminals.rs}`.
- **Ports**: from `session.ts`: `emit` with `redactMcpCredential` (`:123`–`:177`; the bearer
  becomes `<ACE_MCP_CREDENTIAL>`, `mcp-server/src/injection.ts:212`–`:214`), the frame bound and
  `omittable` (`:129`–`:184`), the correlation deadlines (`:90`–`:106`), every per-session map
  (`:73`–`:124`), `handlers` (`:185`–`:353`), `onNotification` and `onRequest`
  (`:392`–`:405`); `session-state.ts`; `session-discovery.ts` (`:1`–`:294`, the history reads,
  `refreshQueue`, `reconcileLoaded`, recovery observation); `session-lifetime.ts` (its (b) cases
  move); `dropped-line.ts` (b); `tool-facts.ts` (b); `tool-search.ts` (b);
  `background-terminals.ts`; `rate-limits-read.ts`.
- **Timers** through the bridge (`ArmTimer`), with the keys the TypeScript uses.
- **Must not**: decide anything the translator decides; reorder an emit relative to the state
  change after it.
- **Reviewer checks**: `handlers.frame` statement order against `:185`–`:353`; each moved (b)
  case present once.

#### E3-codex.4 Commands and admission

- **Files**: `ace-adapter-codex/src/session/{commands.rs,input.rs,selection.rs,permissions.rs,mcp.rs,catalog.rs,history.rs}`.
- **Ports**: `session-commands.ts` (`createSessionCommands`, `:53`–`:356`), `native-input.ts`,
  `selection.ts`, `resolution.ts`, `permission-policy.ts` (b), `default-permissions.ts`,
  `shell-env.ts` (b), `mcp-controls.ts`, `extension-catalog.ts`, `history.ts` (paged history,
  #693).
- **Admission** (rule 1, E3 form): the facade runs `assertSteerTarget(delivery, fence)` and then
  calls `handle.send(...)` synchronously. Under the session's state lock, that call reads
  `active` for the thread, compares `fence.turn` and refuses with `ACE_STEER_TARGET_LOST` when
  they differ (`:92`–`:95`). It then takes the `clientUserMessageId` from the injected
  `userMessageId` port (which the facade passes in as a value), queues the `onInputMessage`
  callback before the write (identity before echo, §8), and pushes `turn/steer` with
  `expectedTurnId` set to the turn it read. Codex's own refusal maps to `SteerTargetLost` exactly
  as at `:117`–`:135`. Queue delivery (`thread/queue/add` and then `refreshQueue`) and `startTurn`
  (whose launch options are an awaited port) keep their awaits before the synchronous push.
- **Must not**: retry a `SteerTargetLost`; move the check after any await.
- **Reviewer checks**: the check, the read and the push sit in one lock scope; `steer-race`
  semantics walked through in the PR.

#### E3-codex.5 The binding, facade, switch and proof

- **Files**: `ace-daemon-node/src/session_codex.rs`, `packages/adapter-codex/src/native-session.ts`,
  `session.ts` (one line: the first statement of `openCodexSession`, `:55`, as in E3-pi.2),
  `host-pool.ts` (the one-line `close` change of E3-codex.2),
  `apps/daemon/bench/session-stream/codex.ts`.
- **Facade**: every `ProviderSession` method is one binding call plus `bridge.expect`.
  `nativeSessionId` and `sessionConfirmed` are synchronous getters. `close(reason)` runs the
  lifetime's stop (`session-lifetime.ts`): the interrupt through the peer, bounded at 10 s, then
  the TypeScript `proc.stop` of the host when the session is its last tenant. It resolves only
  on confirmed exit, as today (rule 5).
- **Proof** (alone, three modes): the 27 Codex session files of behaviour.md §19 (including
  `steer-race.process`, `shutdown-drain.process`, `oversized-lines.process`,
  `inherited-pipes.process`); `apps/daemon/src/engine/` `codex-exit-log.process`,
  `codex-admission-restart.process`, `codex-late-ack-quota.process`, `codex-stderr.process`,
  `codex-orphan-quota.process`, `provider-diagnostics.process`, `review-recovery.process`,
  `provider-permissions.process`, `recorded-ask.process`, `attachment-echo.process`;
  `engine/reliability.process.test.ts` (`:348`).
- **Cross-mode**, both ways, through `scripts/native-cross.ts ACE_SESSIONS` (with
  `ACE_STORE=native ACE_SUPERVISOR=native` and the addons set): `item-invalidated-recovery.process`,
  `overlapping-recovery.process`, `review-recovery.process` (adapter), and
  `engine/codex-admission-restart.process`, `engine/review-recovery.process`,
  `engine/restart-origin.process`. A thread whose native session id one backend stored is
  resumed by the other.
- **Bench**: `session-stream.ts` with the Codex fake, in its four modes.
- **Reviewer checks**: as E3-pi.2; plus no TypeScript state is mirrored (the facade holds no
  maps).

### E3-acp: ACP (JSON-RPC over stdio, one agent process per session)

#### E3-acp.1 Session core and capture

- **Files**: `native/daemon/crates/ace-adapter-acp/src/session/{mod.rs,core.rs,frames.rs,routing.rs,deadlines.rs,negotiation.rs,configuration.rs}`.
- **Ports**: `session.ts`'s `AcpSession` (`:118`–`:940`), the frame capture (`:361`–`:381`)
  through the E1 port of `frame-redaction` (`translate/frame_redaction.rs`) and binary elision,
  settlement in frame order inside the peer's frame callback (`:200`–`:212`; a continuation after
  an await would run too late, `:203`–`:204`), `session-routing.ts`, `deadlines.ts`,
  `negotiation.ts`, `bridge-negotiation.ts`, `configuration.ts` (its (b) cases move),
  `identity.ts`, `resume-error.ts`, `quirks/antigravity.ts`, over the E3-codex.1 peer and a
  diverted child.
- **Must not**: use `agent-client-protocol`'s connection (fact 4); change `translate/`.

#### E3-acp.2 Prompts, steering and close

- **Ports**: `send`, `steerNow` (`:644`–`:660`: `fence.current()` then the `_session/steering`
  request in one synchronous step), `interrupt`, `resolve`, `stopTask`, `setModel`, `setMode`,
  `close` (`:901`–`:940`, with the Windows `stopTreeAfterEof` staying TypeScript through the
  facade).
- **Admission**: as E3-codex.4, with ACP's check (`session.ts:645`).

#### E3-acp.3 Binding, facade, switch and proof

- **Files**: `ace-daemon-node/src/session_acp.rs`, `packages/adapter-acp/src/native-session.ts`,
  `session.ts` (one line, the first statement of `openAcpSession`, `:66`),
  `apps/daemon/bench/session-stream/acp.ts`. `openWithSignIn` (`provider-kit/acp-sign-in.ts:14`)
  stays TypeScript around the native open.
- **Proof** (alone, three modes): the 14 ACP session files of behaviour.md §19;
  `apps/daemon/src/engine/` `acp-selection.process`, `acp-resume-failure.process`,
  `acp-stop-shell.process`, `acp-access.process`, `adapter-echo.process`.
- **Cross-mode**, both ways: `adapter-acp/src/integration-restart.test.ts`,
  `engine/acp-resume-failure.process`, `engine/acp-selection.process`.
- **Bench**: `session-stream.ts` with the ACP fake.

### E3-opencode and E3-cursor (outlines; briefed after E3-acp)

- **OpenCode**: HTTP and SSE to a pooled `opencode serve`. Rust takes the server pool, the SSE
  reader (`ace_supervisor::sse`, `eventsource-stream` over `reqwest` without TLS) and the
  per-event session state; the request client is `reqwest`. The prompt check stays after the
  admission lock and the session barrier (`adapter-opencode/src/prompts.ts:52`–`:57`), with the
  check and the request in one synchronous step. Its plugins (`agent-env-plugin/`,
  `mcp-ready-plugin/`) stay TypeScript, loaded by OpenCode. The server's stdout is diverted like
  any child's. The flow gate pauses the SSE read. Cross-mode: `ancestry-recovery.process`,
  `server-pool-recovery.process`.
- **Cursor**: Rust speaks the host wire (`host.ts`'s side of `host-wire.ts`) over the E3-codex.1
  peer to the host child, which stays TypeScript (`host-entry.ts`, `@cursor/sdk`). Frames and
  records commit in one transaction on the engine side, so this item waits for E5.3. Cross-mode:
  `checkpoint-recovery.process`, `recovered-seam.process`, `engine/cursor-*.process`.
- **Claude**: none here (ADR 0223, decided by the orchestrator; the owner moved it to the
  providers work).

### Reviewing an E3 task

The reviewer (Codex, then Opus for the merge) checks:

1. The task touched only its files; the TypeScript off path is byte-identical.
2. Rule 3: every frame, settle, timer and exit goes through one `EventQueue`, in push order,
   with `Drained` last; nothing reaches JS by another path.
3. Rule 1: the steer check and the push are in one synchronous step (TS check, then one
   synchronous binding call, under the state lock where Rust state is read).
4. Rule 4: readers stop on the gate, never drop; `cancelled` reads to EOF within budget.
5. Rule 5: `close` resolves only on confirmed exit; on rejection the handle, its queue and the
   child stay whole.
6. Redaction before every `Frame` effect; wire bytes are the original.
7. No Rust timer or clock in protocol logic; `t` from the injected `now`.
8. The proof files pass alone in all three modes, the cross-mode list both ways, the (b) cases
   are moved one for one, and the bench numbers are in the PR.

### Questions for the owner (E3)

1. **Pi has no cross-mode file.** No existing test reboots a home with a Pi thread, so the E3
   gate has nothing to run for Pi. The session-reference files stay written by TypeScript in both
   modes, so a rollback can't misread them. Accept that, or allow one new process test that
   resumes a Pi thread across two boots?
2. **A bench gate for sessions.** ADR 0223 §8 names no bench for E3. Proposed: a session goes
   default-on only when `apps/daemon/bench/session-stream.ts` is no slower than everything off.
   Accept?
3. **`agent-client-protocol`.** The TypeScript ACP adapter uses ace's own JSON-RPC peer and only
   two constants from the SDK. Keep the crate for those two constants and the schema types, or
   drop it and write the constants out?
4. **Timing.** The recommendation is E3.0 and E3-pi now, with Codex and ACP held until store
   phase 5 and E5.1 to E5.4 are under way. Or build all of E3 now?

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
| E5.8 recovery and restart                | `recovery`, `restart`, `restart-resume`, `restart-eligibility`, `restart-captures`, `provider-recovery`, `provider-return`, `cursor-reconcile`, `cursor-attempt`, `cursor-empty-migration`, `recover-limited-children`, `lost-work`, `session-bound-tasks`, `imported-thread`                                                                                                                                        | `recovery`, `restart`, `cursor_reconcile`                                                                                 | restart row, limits row, Cursor row                                                                                                               | `cursor-attempt-record`, `restart-ledgers.process`, `session-bound-tasks.process`, `cursor-migration.process`                                                                              |
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
  transaction's after-commit queue (dropped on rollback); the pump is the only place tasks run, from a Bun macrotask only, never inside a binding call or an open transaction or another pump; it stops starting tasks after 64 or 4 ms and empties the control queue first. Scheduling is the one-claim state machine of ADR 0223 §4 (`Idle`, `Scheduled`, `Running`, `RunningDirty`): only the move into `Scheduled` posts a notification, so at most one is pending; a `napi_closing` result is logged and leaves the state `Scheduled`. A frame batch's acknowledgement resolves where it does today: on its transaction's commit, or for established deltas on their acceptance into the live buffer, never on the buffer's flush or a savepoint's release. Guarded by `engine/reliability.process`,
  `signal-batching.process`, `storage-behaviour.process` and `live-write-buffer.process`; a
  re-entrant call from a port must not panic in any (a) file.
- Graceful close (E5.8): per thread, flush, then capture restart evidence (continuation and the
  open request it waits on, `recovery.ts:293`–`:303`) **before** any session closes, then close the
  sessions (behaviour.md §2). Guarded by `restart-resume.process.test.ts:345`, `:357`, `:384`.
- Lost contact (E5.10): a remote child's hold is never ended by lost contact; the child reads
  `needs_you` with the person's question on its agent (behaviour.md §12). Guarded by
  `machines/remote-child-lost-contact.process.test.ts`.
- Startup recovery (E5.8): the same set of threads, recovered the same way, but found in bounded
  slices (256 rows of `threads`, `intents`, `engine_queue` by primary key, same predicate as
  `repository.ts:255`–`:282`), each slice and each thread's recovery a separate pump step;
  `ready()` still resolves only after the last one. Guarded by the restart row and
  `startup-quarantine.process`; time it on a clone of a large home with a cold cache, never with a
  daemon on the clone.
- Run the E5 cross-mode list (ADR 0223 §8) through `scripts/native-cross.ts` before you report,
  and `bun apps/daemon/bench/head-of-line.ts` with `ACE_ENGINE` off and on: `stopAck` and
  `sendReceipt` p50, p99 and max under the `live` bulk must be no worse than TypeScript.
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
