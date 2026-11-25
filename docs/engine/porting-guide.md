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

**Owner decision (2026-11-23): pilot only.** Build E3.0, E3-pi.1, E3-pi.2 and E3-pi.2b now.
E3-codex and E3-acp come later and are not to be built from this section yet.

**Recommendation (as reviewed).** Build E3.0 and E3-pi now, as a pilot. They are small, Pi is the least used
provider, and they prove the bridge, the pipe diversion (E3.0b) and the session bench (E3.0d)
before Codex depends on them. Hold E3-codex and E3-acp until store phase 5's writer and the E5
skeleton (E5.1 to E5.4) are under way. Then build them so that their Rust cores implement
`ace_adapter_api::Session`, and E5.6 drives them with no JavaScript in between. That is when the
crossings disappear. Before it, Codex would carry the most risk and show no gain on the daemon
bench. For performance, the order is: store phase 5 → T2 → T3 (fan-out off the JS thread) and E5
in parallel → E3-codex and E3-acp with E5.6 → T4 → OpenCode and Cursor. A session goes default-on
only when the E3.0d bench is no slower than everything off for its provider (owner decision 2;
metric and aggregation in E3.0d, step 6), on top of the ADR 0223 §8 gates.

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
   budgets, dropped lines and the redacted capture stay ace's. `agent-client-protocol` is in
   `ace-adapter-acp/Cargo.toml:21`, but nothing in `ace-adapter-acp/src/` uses it (E1's
   translator doesn't). So, by owner decision 3, E3-acp.1 removes it and defines the two
   constants locally.

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
  writes the code, and Codex reviews it. Each brief is the task's section copied whole, plus
  these rules. Do its numbered steps in order, one at a time, and commit after each step that
  builds. Use the exact names, signatures, messages and numbers the brief gives. If a step
  names a line of TypeScript, read that line before writing its port. If the brief is wrong,
  incomplete, or contradicts the code, stop and report what you found. Never fill a gap with your
  own design, and never change a file the task doesn't list.
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

Steps, in order:

1. In `packages/provider-kit/src/native-switches.ts`, export a pure function:
   `sessionSwitchRefusal(input: { sessions: readonly string[]; store: boolean; supervisor: boolean; cross: CrossSwitch | undefined }): string | undefined`.
   Let `named` be `input.sessions.length > 0 || input.cross === "ACE_SESSIONS"`. Return the first
   of these that applies, else `undefined`:
   1. `named && !store` → `"ACE_SESSIONS needs ACE_STORE=native"` (today's message);
   2. `named && !supervisor` → `"ACE_SESSIONS needs ACE_SUPERVISOR=native"`;
   3. `input.sessions.length > 0 && cross === "ACE_SUPERVISOR"` →
      `"ACE_NATIVE_CROSS=ACE_SUPERVISOR cannot run with ACE_SESSIONS"` (a boot on the TypeScript
      supervisor could not divert a pipe).
2. Call it at module load, right after the `offender` check (`:105`–`:115`), and throw
   `new Error(message)` when it returns one. Leave the `offender` chain and its messages as they
   are.
3. Export `sessionsAddonPath(): string`. It returns `ACE_SESSIONS_ADDON` if set, else
   `ACE_STORE_ADDON` if set, else
   `fileURLToPath(new URL("../../../native/daemon/target/release/<library>", import.meta.url))`,
   with `<library>` chosen per platform as `adapter-pi/src/native-translator.ts:24`–`:29` does.
   Every session shell loads its addon from this path. If no file is there, loading throws
   `ACE_SESSIONS=<p> needs the sessions addon at <path>`. It never falls back.
4. `tools/daemon-bench/src/daemon.ts:60`–`:64`: keep the `ACE_SESSIONS` row refusing, and change
   its `absent` text to
   `"the daemon bench's only provider is claude, which has no native session; measure sessions with apps/daemon/bench/session-stream.ts"`.
   That bench cannot show a session switch at work (E3.0d does).
5. `scripts/test-home-policy.ts:121`: beside `ACE_SESSIONS`, keep `ACE_SESSIONS_ADDON` and
   `ACE_SUPERVISOR_ADDON` the same way.
6. Add one `test.each` table to `packages/provider-kit/src/native-switches.test.ts` over
   `sessionSwitchRefusal`. Rows: each of the three refusals alone; store and supervisor both off
   (expects the store message, so the order is pinned); `cross: "ACE_SESSIONS"` with no sessions
   and no supervisor; no sessions and no cross (expects `undefined`). It is new behaviour, so the
   commit message says so.

- **Run**: `bun --bun x vitest run packages/provider-kit/src/native-switches.test.ts --maxWorkers=4`.
- **Must not**: change any other switch's parsing or messages, or read the environment anywhere
  else.
- **Reviewer checks**:
  `ACE_STORE=native ACE_SESSIONS=pi bun -e 'await import("@ace/provider-kit/native-switches")'`
  throws the supervisor message, and swapping steps 1.1 and 1.2 makes the table fail.

#### E3.0b Diverting a native child's pipes and flow to a Rust consumer

The session must own everything the TypeScript stream owned for a piped child: the bytes, the
pause and resume of each pump, stdin, and the end of the pipes. Today the shell answers
`Delivered::taken(false)`, which pauses the pump (`ace-supervisor/src/spawn.rs:176`–`:181`), and
it resumes the pump through `SupervisedChild::resume_output` (`child/mod.rs:331`). After
diversion, the session does both.

Steps, in order:

1. Create `native/daemon/crates/ace-supervisor/src/divert.rs` and add `pub mod divert;` to
   `lib.rs`. Put these types in it, exactly:

   ```rust
   /// A Rust consumer of a diverted child, fixed at spawn. Events arrive in the order the
   /// supervisor produces them, from tokio threads.
   pub trait OutputConsumer: Send + Sync + 'static {
       fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered);
       fn end(&self, stream: OutputStream);
       fn stdin_written(&self);
       fn stdin_error(&self, error: NodeIoError);
       /// The leader's end (node's `exit`). Pipes may still drain.
       fn exit(&self, exit: RawExit);
       /// The pipes are done (node's `close`): no byte follows. The terminal barrier.
       fn close(&self, exit: RawExit);
   }
   /// The child's controls, filled by the spawn before it returns.
   pub struct ChildPorts {
       pub stdin: StdinPort,
       pub output: OutputControl,
   }
   /// What a session hands to the spawn.
   pub struct DivertTarget {
       pub consumer: Arc<dyn OutputConsumer>,
       pub ports: Arc<std::sync::OnceLock<ChildPorts>>,
   }
   /// Writes into the child's stdin queue (`StdinMessage`), in order with every other write.
   #[derive(Clone)] pub struct StdinPort { /* UnboundedSender<StdinMessage> */ }
   impl StdinPort {
       pub fn write(&self, bytes: Vec<u8>) -> Result<(), SupervisorError>; // Closed once the pump ended
       pub fn end(&self);
   }
   /// Pause and resume of both pumps, as the JS stream did it.
   #[derive(Clone)] pub struct OutputControl { stdout: Option<Arc<Flow>>, stderr: Option<Arc<Flow>> }
   impl OutputControl {
       pub fn resume(&self, stream: OutputStream); // Flow::resume (pump/mod.rs:161)
       /// Flow::close (pump/mod.rs:179) after marking the flow `end_on_close`: the pump stops,
       /// closes its end, and still emits `end` (step 2b).
       pub fn close(&self, stream: OutputStream);
   }
   /// The sink a diverted child is spawned with.
   pub struct Diverted<E: EventSink> { shell: E, consumer: Arc<dyn OutputConsumer> }
   ```

2. Implement `EventSink for Diverted<E>` with exactly this routing:

   | Event                          | To the consumer              | To the shell (JS)                     |
   | ------------------------------ | ---------------------------- | ------------------------------------- |
   | `output`                       | yes (it answers `delivered`) | no                                    |
   | `end`                          | yes, first                   | yes, after (the JS stream ends empty) |
   | `exit`, `close`                | yes, first                   | yes, after                            |
   | `stdin_written`, `stdin_error` | yes                          | no                                    |
   | `hold_limit`, `held`           | no                           | yes                                   |

2b. **`end` on every close path.** Today `Flow::close` cancels the pump, which returns without
`sink.end` at both of its cancel points (`pump/mod.rs:265`, the wait for room, and `:282`, the
read). A diverted child's JS readables would then never end. So add
`end_on_close: AtomicBool` to `Flow` (false by default), set by `OutputControl::close` before
it calls `Flow::close`. At both cancel points of `pump_output`, call `sink.end(stream)` before
returning when the flag is set. With the flag unset (every undiverted child, and JS's own
`closeOutput`), the pump returns as today. The pump emits `end` at most once on every path, and
always before the child's `close` (`child/mod.rs:269`–`:273` awaits the pumps first). 3. In `child/mod.rs`, add `pub fn ports(&self) -> Option<ChildPorts>`. It returns the stdin
sender as a `StdinPort` and the stdout and stderr `Flow`s as an `OutputControl`, and returns
`None` when stdin or an output isn't piped. 4. In `ace-daemon-node/src/supervisor/child.rs`, add `#[napi] pub struct NativeOutputTarget`
holding a `DivertTarget`. It has no constructor reachable from JS; only the session bindings
(E3-pi.2 and later) make one. Change `supervisor_spawn` (`:146`) to
`supervisor_spawn(spec_json, events, target: Option<&NativeOutputTarget>)`. With a target, it
spawns with `Diverted { shell: TsfnSink, consumer }` and sets `target.ports` from
`child.ports()` before it returns. Without a target, nothing changes. 5. On a diverted `NativeChild`: `writeStdin` throws `"stdin is owned by the native session"`, and
so do `resumeOutput` and `closeOutput`. `endStdin`, `abortStdin`, `kill`, `signalGroup` and
the rest work as before. The Windows stop ends stdin (`adapter-pi/src/session.ts:61`–`:67`),
and TypeScript still stops the process. 6. In `packages/provider-kit/src/native-process.ts`, export the opaque type
`NativeOutputTarget`, and pass it from `nativeSpawnChild`'s spec to `supervisorSpawn`. 7. In `packages/provider-kit/src/process.ts`, add `nativeOutput?: NativeOutputTarget` to
`SpawnOptions` (`:85`) and pass it in the native branch of `spawnOwned` (`:185`–`:197`). If
`nativeOutput` is set and the backend is TypeScript, throw
`"nativeOutput needs ACE_SUPERVISOR=native"` before spawning. Nothing else in `spawnOwned`
changes. The diverted child's `stdout` and `stderr` Readables carry no data and end on their
`*-end` events. 8. Add a `#[cfg(test)]` table in `divert.rs` over step 2's routing, with a recording consumer
and a recording shell, plus one case per cancel point of step 2b (a closed flow with
`end_on_close` emits exactly one `end`, then `close`). It is new behaviour, so the commit says
so.

- **Run**, off and with `ACE_SUPERVISOR=native`, each alone:
  `packages/provider-kit/src/process.process.test.ts`, `fast-exit.process.test.ts`,
  `process-stop.process.test.ts`. They must not change, because nothing diverts yet.
- **Must not**: change an undiverted event, the stop plan, or the inventory or registry calls;
  add a dependency.
- **Reviewer checks**: the routing matches cell by cell; an undiverted spawn's path is unchanged
  (diff `spawnOwned`); a diverted child's flows can be resumed only through `OutputControl`.

#### E3.0c The session bridge (shared by every native session)

- **Files**: create `native/daemon/crates/ace-adapter-api/src/bridge.rs` (`pub mod bridge;`;
  `ace-adapter-api/Cargo.toml` gains `tokio` with `sync` only, with a comment saying why);
  `native/daemon/crates/ace-daemon-node/src/session_bridge.rs` (and its `mod` line);
  `packages/provider-kit/src/native-session-bridge.ts` (new, exported from
  `@ace/provider-kit/native-session-bridge` in `package.json`).

Steps, in order:

1. In `bridge.rs`, define the events and the queue:

   ```rust
   pub enum SessionEvent {
       /// `text` is the redacted JSON text of the frame's data; seq is assigned at push.
       Frame { seq: u64, dir: FrameDir, channel: String, text: String },
       /// One context callback, by name (`onSessionIdentity`, ...), JSON array of arguments.
       Callback { name: &'static str, json: String },
       /// Settles the facade's promise `id`.
       Settle { id: u64, result: Result<String, SessionErrorWire> },
       ArmTimer { key: String, ms: f64 },
       CancelTimer { key: String },
       /// The session cannot go on: the facade closes it, unexpected.
       Fatal { message: String },
       /// Last event: the child's pipes are closed and every frame they produced is before it.
       Drained,
   }
   pub struct SessionErrorWire { pub code: &'static str, pub message: String }
   pub struct EventQueue { /* Mutex<Inner { events: VecDeque<SessionEvent>, next_seq: u64, drained: bool }>, wake */ }
   impl EventQueue {
       /// Pushes every event of one input under one lock, in order. Frames get their seq here.
       /// After `Drained` it drops the events and logs once; it never panics.
       pub fn publish(&self, events: Vec<SessionEvent>);
       pub fn take_batch(&self, max_frames: usize, max_bytes: usize) -> Vec<SessionEvent>;
   }
   ```

   Sessions call `publish` while they still hold their own state lock (E3-pi.2, step 2), so two
   inputs, one from tokio and one from JS, never interleave their events. Each input's events
   appear in the order its state changed.

2. In `bridge.rs`, define the read gate (ADR 0223 §7 rule 4):

   ```rust
   pub enum GateState { Open, Paused, Failed, Draining }
   pub struct ReadGate { /* Mutex<Inner { state: GateState, before_drain: Option<GateState>, paused_while_draining: Option<bool>, exited: bool, output: Option<OutputControl> }> */ }
   impl ReadGate {
       pub fn attach(&self, output: OutputControl);
       /// Answers one delivered chunk under the gate's lock: `delivered.taken(false)` for Paused
       /// and Failed, `taken(true)` for Open and Draining. Never read the state and answer later.
       pub fn answer(&self, delivered: Delivered);
       /// Under the lock. Paused→Open resumes both streams. In Draining it changes nothing now
       /// but records the latest value in `paused_while_draining`, so a pause or resume that
       /// arrives during a stop is not lost.
       pub fn set_paused(&self, paused: bool);
       /// Latches failure: no resume ever. In Draining it only sets `before_drain = Failed`
       /// (the drain goes on), so a later undrain restores Failed.
       pub fn fail(&self);
       /// From Open, Paused or Failed: save that state in `before_drain`, →Draining, resume both
       /// streams. A second drain keeps the first saved state.
       pub fn drain(&self);
       pub fn exited(&self);                // sets `exited`, then drain()
       /// A close whose stop failed: restore `before_drain`, then apply `paused_while_draining`
       /// if one was recorded, and clear both. So: Failed stays failed whatever was recorded,
       /// and is never resumed. Open or Paused with a recorded `false` (outputFlow.wait()
       /// resolved during the stop) comes back Open, with both streams resumed. Open or Paused
       /// with a recorded `true` comes back Paused. With nothing recorded, the state before the
       /// drain comes back exactly (Paused answers the next chunk taken(false), and only a later
       /// set_paused(false) moves it to Open). A no-op once `exited` is set, or when not
       /// Draining.
       pub fn undrain(&self);
   }
   ```

   **The check and the pause are one step.** `answer` holds the gate's lock while it reads the
   state and calls `taken(false)` (which pauses the pump's `Flow`), and `set_paused(false)` holds
   the same lock while it moves to Open and calls `OutputControl::resume`. So a resume can't land
   between the check and the pause: either the pause comes first and the resume undoes it, or
   the resume comes first and the chunk is answered `taken(true)`. There is no `more()` accessor.

   The facade calls `drain` on cancellation (a close starts), and the session calls `exited` on
   the leader's `exit`. From then on the gate no longer pauses: everything the child wrote reaches
   the queue, bounded by the process's output budget. The queue to JS always drains, so nothing
   read is dropped.

3. Error codes are fixed strings: `ACE_STEER_TARGET_LOST`, `ACE_INPUT_REJECTED`, and each
   provider's own. Pi's are `ACE_PI_COMMAND_REFUSED` (the command was not taken) and
   `ACE_PI_UNCERTAIN` (it may have run).
4. In `session_bridge.rs`, `SessionPort`, one per native session: one
   `ThreadsafeFunction<String, ()>` and the `EventQueue`. A publish wakes the port, which posts at
   most one call at a time (the single-claim rule of ADR 0223 §4). One call carries one batch of
   at most 256 frames or 256 KiB of frame text, encoded with `ace_json::ser::to_string` as
   `[[kind, ...fields], ...]`. After the batch holding `Drained` has been delivered, the port
   releases the function. Add `#[napi]` methods `set_paused`, `fail` and `drain`.
5. In `native-session-bridge.ts`:

   ```ts
   export interface NativeSessionPort {
     setPaused(paused: boolean): void;
     fail(): void;
     drain(): void;
   }
   export interface BridgeHooks {
     now(): number; // the adapter's injected clock
     started: number;
     schedule(callback: () => void, ms: number): () => void; // the adapter's injected timer
     timer(key: string): void; // calls the handle back when an armed timer fires
     fatal(message: string): void; // the facade's close("shutdown", false)
     drained(): void; // the facade's exit path
   }
   export function sessionBridge(
     ctx: SessionContext,
     port: NativeSessionPort,
     hooks: BridgeHooks,
     errors: Readonly<Record<string, new (message: string) => Error>>,
   ): {
     deliver(batch: string): void; // the threadsafe function's callback
     expect(id: number): Promise<unknown>; // settled by a Settle event
     drainedPromise: Promise<void>; // resolves after Drained was handled
   };
   ```

6. `deliver` parses the batch and handles each event in order, with no `await`:
   - `Frame`: `const payload = new ProviderPayload(text)`, then
     `ctx.onFrame({ seq, t: Math.max(0, Math.round(hooks.now() - hooks.started)), dir, channel, data: payload.data, payload })`.
     If that returns a promise and it rejects, call `port.fail()` (as `engine/sessions.ts:684`–`:699`
     stops intake). Then, if `ctx.outputFlow?.paused()` and the port isn't already paused, call
     `port.setPaused(true)`, and `port.setPaused(false)` when `outputFlow.wait()` resolves.
   - `Callback`: `ctx[name]?.(...JSON.parse(json))`.
   - `Settle`: resolve the promise from `expect(id)` with `JSON.parse(json)`, or reject it with
     `new errors[code](message)`. `ACE_STEER_TARGET_LOST` maps to `SteerTargetLost` and
     `ACE_INPUT_REJECTED` to `InputRejected`; an unknown code maps to a plain `Error`.
   - `ArmTimer` and `CancelTimer`: `hooks.schedule(() => hooks.timer(key), ms)`, keeping the
     cancel by key; cancel it on `CancelTimer`.
   - `Fatal`: `hooks.fatal(message)`.
   - `Drained`: cancel every armed timer, reject every promise still pending with
     `Error("session closed")`, resolve `drainedPromise`, then call `hooks.drained()`. Nothing
     is handled after it.

- **Tests**: none new; E3-pi.2's files prove it. **Bench**: none.
- **Must not**: deliver a frame, settle or exit any other way (rule 3); `await` inside
  `deliver`; build a `Frame` anywhere else.
- **Reviewer checks**: `publish` takes the whole input's events under one lock; one threadsafe
  function per session with at most one call in flight; release only after `Drained`; batch
  bounds of 256 frames and 256 KiB; `t` comes from the injected `now`; the gate's four states
  match step 2.

#### E3.0d The session bench

- **Files**: create `apps/daemon/bench/session-stream.ts` and its fake
  `apps/daemon/bench/session-stream/pi.ts`. Codex and ACP fakes come later, with their tasks.

Steps, in order:

1. The fake answers the open handshake as `packages/adapter-pi/src/testing/fake-pi.ts` does (copy
   its `get_commands` and `get_state` replies). Pi's open checks the saved history's header
   (`checkedSessionReference`, `session-header.ts:58`–`:66`, which reads the first line of
   `sessionFile`). So before the run the bench writes a valid history file with
   `sessionFixture(home, "bench", 3)` from `packages/adapter-pi/src/testing/native-history.ts`,
   and the fake's `get_state` returns that file's path and id. On each `prompt`, it prints a turn: 2,000
   `message_update` lines, one `message_end` and one `agent_end` (the shapes
   `translator.ts:162`–`:205` reads). The bench sends ten prompts, one after another.
2. The bench opens the session through `createPiAdapter().openSession(ctx)`, with an `io.spawn`
   that runs the fake (as `testing/harness.ts:120`–`:128` runs `fake-pi.ts`). `ctx.onFrame` runs
   the adapter's translator on each frame, as the engine does, and returns a resolved promise.
3. **Evidence of the native path.** The native Pi facade (E3-pi.2) appends one JSON line
   `{ "provider": "pi", "backend": "native", "pid": <process.pid> }` to the file named by
   `ACE_SESSIONS_EVIDENCE` when it opens, if that variable is set. In the sessions mode, the bench
   sets it to a fresh empty file and checks afterwards that the file holds exactly one line per
   open. If it doesn't, the run is void. In the other modes the file must stay empty.
4. **Metric**: `cpuMsPer1000Frames` = (user + system microseconds from `process.cpuUsage()` over
   the ten turns) / 1000 / (frames delivered / 1000). `process.cpuUsage()` covers every thread of
   the process, so the addon's tokio threads count too. Also record frames per second and
   `heapUsed` after two forced GCs. Write the JSON to `--output`.
5. **Modes**: A = off; B = `ACE_TRANSLATORS=pi`; C = B plus `ACE_STORE=native ACE_SUPERVISOR=native`;
   D = C plus `ACE_SESSIONS=pi`. Each mode runs in its own process. Mode D runs only once E3-pi.2
   has merged; until then the bench refuses it.
6. **Aggregation and the default-on rule** (owner decision 2): run three rounds of A B C D, back
   to back, one bench at a time. A round whose one-minute load average differs by more than 2×
   between its A and D runs is discarded and rerun. For each round take the ratio
   `D.cpuMsPer1000Frames / A.cpuMsPer1000Frames`. Pi may go default-on only if the median of the
   three ratios is ≤ 1.00 and D's median frames per second is ≥ A's. Report B and C beside them,
   and heap for information.

- **Must not**: spend quota, start a real CLI, or run beside another bench.
- **Reviewer checks**: mode D is void without the evidence lines; the frames are real Pi shapes;
  the ratio and median are computed as in step 6.

### E3-pi: Pi (JSONL over stdio, one process per session)

The split for Pi: Rust takes everything that runs per line or per write. That is `rpc.ts` whole,
and the half of `session.ts` that inspects frames, tracks dialogs, redacts, frames stdout and
stderr and ends the stream. The facade keeps the open-time and control composition in TypeScript:
discovery, MCP configuration, session references, launch arguments, `verifyExtension`,
`restore`, `fork`, `rollback`, and `send` and `interrupt` as sequences of `request`s. That
composition reads no per-frame state between a check and its write, so rule 1 holds with the
TypeScript check followed by a synchronous `request`, as today (`session.ts:404`–`:410`). The
session-reference files (`session-references.ts`) also stay written by one implementation, which
makes cross-mode resume safe by construction. E3-pi.3 moves the composition to Rust with E5.

#### E3-pi.1 The Pi wire core in Rust (sans-IO)

- **Files**: create `native/daemon/crates/ace-adapter-pi/src/session/{mod.rs,wire.rs,dialogs.rs,redact.rs,error.rs}`;
  delete `src/session.rs` (the E0 stub) and declare `pub mod session;` for the directory. In
  `Cargo.toml`, remove `rmcp` (fact 3 above) and add nothing.
- **Ports**: `adapter-pi/src/rpc.ts` whole (`PiRpc`, `:12`–`:124`). From `session.ts`: the
  redaction (`:129`–`:133`), the `recv` inspection (`:217`–`:259`: rollback acknowledgement,
  dialog tracking with its timeout, `fatal` on an unparseable blocking dialog), dialog expiry
  (`:195`–`:202`), `resolve`'s reservation and its deadline resumption (`:430`–`:445`), and the
  stderr line path (`:135`–`:138`, `:261`–`:265`). From `native.ts`: the `Response`, `Dialog`
  and `isBlockingDialogMethod` shapes (`:14`–`:42`), as `ace-json` lookups, not serde structs.

Steps, in order:

1. In `error.rs`, define the two kinds of failure. A builder must never mix them up: a refused
   prompt can be retried, an uncertain one may already have run.

   ```rust
   /// The command was not taken: nothing reached Pi, or Pi answered `success: false`.
   /// Maps to ACE_PI_COMMAND_REFUSED (the facade's PiCommandRefused).
   pub enum Refused { Closed, Capacity, FrameLimit, Rejected(String) }
   // Display: "Pi RPC closed", "Pi command capacity exceeded",
   //          "Pi command exceeds frame limit", the string Pi sent or "Pi command rejected".
   /// The command may have run. Maps to ACE_PI_UNCERTAIN (a plain Error in the facade).
   pub enum Uncertain { TimedOut, Mismatch, StdinFailed(String), Closed, WriteQueueFull, StdinClosed }
   // Display: "Pi command timed out; execution uncertain", "Pi response command mismatch",
   //          the stdin error's node message (e.g. "write EPIPE"), "Pi RPC closed",
   //          "JSON-RPC write queue exceeded limit" (rpc-writer.ts:37),
   //          "JSON-RPC stdin closed" (rpc-writer.ts:88).
   pub enum PiError { Refused(Refused), Uncertain(Uncertain) }
   ```

   `Uncertain::Closed` is for a request whose bytes were already handed to stdin when the wire
   closed. One closed before its write is `Refused::Closed`, as today: `PiRpc.close` rejects
   pending requests with the plain `Error("Pi RPC closed")` (`rpc.ts:113`–`:123`), which
   `send` treats as uncertain once `requested` is set (`session.ts:413`–`:421`).
   `WriteQueueFull` and `StdinClosed` are plain `Error`s today too (`RpcWriter` rejects with
   them after the request was reserved), so they stay on the uncertain side. Don't "fix" that
   here.

2. In `wire.rs`, define the effects of one input:

   ```rust
   pub enum Effect {
       Frame { dir: FrameDir, channel: &'static str, text: String }, // already redacted
       Write { wire: Vec<u8> },                                     // original bytes + "\n"
       Settle { id: u64, result: Result<String, PiError> },
       ArmTimer { key: String, ms: f64 }, CancelTimer { key: String },
       Fatal { message: String },
       Drained,
   }
   ```

3. Define `PiWire`, with this state: `pending: IndexMap<String, Pending>` (at most 64);
   `seq: u64` (the `ace-<n>` counter); `writes: VecDeque<WriteRecord>` (each write handed to
   stdin and not yet acknowledged, in order: the redacted send text, the facade's promise id, the
   correlation id if any, and `resume_deadlines_after: bool`); `dialogs: IndexMap<JsString, (String, Option<String>)>`
   (the dialog's raw JSON text, an exact JavaScript string id, and its timer key); `waiting_on_human: bool`; `rollback: Option<(String, Option<bool>)>`;
   `closed: bool`; `stdin_failed: Option<String>`; the stderr `DroppedNotes`; and
   `queued_bytes: usize`, the write budget. The limit is `2 * 1024 * 1024`, Pi's today
   (`new RpcWriter(proc.stdin, 2 * 1024 * 1024)`, `rpc.ts:43`; the check is
   `rpc-writer.ts:36`–`:37`). Each `WriteRecord` carries its `charge` (its line's UTF-8 bytes
   plus one for the newline). Don't use `ace_supervisor::jsonrpc::WriterQueue`: its `written`
   releases only the one claimed write, and here every write goes to the stdin port at once.
   **Every write's completion releases its charge exactly once, success or failure**:
   `stdin_written` subtracts the oldest record's charge; `write_refused` the newest's;
   `stdin_error` every outstanding record's, as each settles; `close` and `finish` whatever is
   still outstanding. A record is removed from `writes` in the same step that releases its
   charge, so nothing is released twice.
4. Implement its methods. Every method returns its effects in the order the state changed:

   ```rust
   impl PiWire {
       pub fn new(config: PiWireConfig) -> PiWire; // control_secret, lease_bearer
       /// rpc.request (rpc.ts:80-94), validating before it reserves anything:
       /// 1. closed or stdin_failed → Err(Refused::Closed); 64 pending → Err(Refused::Capacity);
       /// 2. seq += 1, id = "ace-<seq>" (as today: an oversized command still uses up its number);
       /// 3. encode {type, ...params, id}; over 1 MiB → Err(Refused::FrameLimit), with no pending
       ///    entry, no timer and no frame left behind;
       /// 4. charge the budget: if `queued_bytes + charge > 2 MiB`, return
       ///    Ok([Settle { id, Err(Uncertain::WriteQueueFull) }]): no pending entry, no timer, no
       ///    frame. The promise settles through the queue, never as a throw, because today it
       ///    rejects asynchronously with a plain Error;
       /// 5. only then insert the pending entry, ArmTimer("deadline:<id>", 30000) unless
       ///    waiting_on_human, add `charge` to `queued_bytes`, push the WriteRecord, and return
       ///    [ArmTimer?, Write].
       pub fn request(&mut self, command: &str, params: &ace_json::Map, id: u64) -> Result<Vec<Effect>, PiError>;
       /// rpc.write (rpc.ts:70-79) for a dialog answer: steps 1, 3 and 4 without correlation.
       /// With `resume_after`, a successful acknowledgement resumes deadlines if no dialog is left.
       pub fn write(&mut self, data: &ace_json::Map, id: u64, resume_after: bool) -> Result<Vec<Effect>, PiError>;
       /// The stdin port refused the Write just returned (the pump has ended: `StdinPort::write`
       /// gave Err). Called by the I/O shell under the same lock (E3-pi.2, step 2). Undo the newest
       /// WriteRecord: release its charge, remove its pending entry, CancelTimer its
       /// deadline, Settle it with Uncertain::StdinClosed, mark stdin_failed, then Fatal. No
       /// reservation is ever left without a settlement.
       pub fn write_refused(&mut self) -> Vec<Effect>;
       /// One stdin write reached the pipe: pop the oldest WriteRecord, release its charge and emit its send Frame
       /// (rpc.ts:78). For a write() record, Settle Ok; then, if resume_after and dialogs is
       /// empty, resume deadlines (rpc.ts:99-103).
       pub fn stdin_written(&mut self) -> Vec<Effect>;
       /// stdin failed: no later write reaches Pi. Release every unacknowledged WriteRecord's
       /// charge and settle its promise (and its pending request) with
       /// Uncertain::StdinFailed(message); set
       /// stdin_failed; then Fatal. A send whose bytes may have reached the pipe is uncertain,
       /// never refused.
       pub fn stdin_error(&mut self, message: &str) -> Vec<Effect>;
       pub fn stdout_line(&mut self, line: &str) -> Vec<Effect>;  // rpc.ts:49-63, then session.ts:217-259
       pub fn stderr_line(&mut self, line: &str) -> Vec<Effect>;  // redacted; empty lines skipped
       pub fn stderr_dropped(&mut self, line: DroppedLine) -> Vec<Effect>;
       pub fn timer(&mut self, key: &str) -> Vec<Effect>;         // "deadline:<id>", "dialog:<id>", "notes"
       pub fn note(&mut self, json: &str) -> Vec<Effect>;         // the facade's lifecycle notes
       /// The dialog's raw JSON text as received, without consuming it (resolve() validates it first).
       pub fn peek_dialog(&self, id: &JsString) -> Option<String>;
       /// resolve()'s reservation (session.ts:435-436): remove the dialog and CancelTimer its
       /// expiry. False when it is no longer pending.
       pub fn take_dialog(&mut self, id: &JsString) -> (bool, Vec<Effect>);
       pub fn dialog_count(&self) -> usize;                       // for idle(), session.ts:328
       pub fn expect_rollback(&mut self, id: String);
       pub fn rollback_result(&self) -> Option<bool>;
       pub fn clear_rollback(&mut self);                          // rollback's finally, session.ts:500
       pub fn finish(&mut self) -> Vec<Effect>;                   // see step 5
       pub fn close(&mut self) -> Vec<Effect>;                    // rpc.ts:113-123
   }
   ```

5. `finish` is called once, at the terminal barrier (E3-pi.2, step 4). It finalizes both
   framers (`JsonLines::finish`, then `DroppingGate::finish`, handling every line they return as
   `stdout_line` and `stderr_line` would), flushes the stderr drop notes, then `close`s, and ends
   with `Drained`.
6. Keep these orders, statement by statement:
   - in `stdout_line`: redact, then `ProviderPayload`'s admission, then the `recv` frame, then
     correlation and settling (`rpc.ts:49`–`:62`), then the session's inspection (rollback
     acknowledgement, dialog, fatal);
   - the mismatch message (`:59`);
   - a new dialog cancels every pending deadline (`pauseDeadlines`, `:95`–`:98`); deadlines are
     re-armed only after a successful answer write, and only when no dialog is left
     (`session.ts:440`, `rpc.ts:99`–`:103`); a dialog that expires re-arms them under the same
     rule (`session.ts:195`–`:202`);
   - a timed-out command settles `Uncertain::TimedOut`, then `Fatal` (`rpc.ts:104`–`:113`);
   - at most one stderr drop note a second, through the `notes` timer.
7. Framing: stdout goes through `ace_adapter_api::util::elision` (hold 16 KiB, text 1 MiB,
   `session.ts:151`), then `ace_supervisor::jsonl::JsonLines::new(1 MiB)`. Stderr goes through
   `ace_supervisor::budget::DroppingGate::new(1 MiB)`. Lines split on CR and LF, as `lineReader`
   does. These are today's numbers (rule 10).

- **Raw fields, not a decoded tree.** `stdout_line` admits like `ProviderPayload` (the 1 MiB byte
  bound, `JSON.parse`, then 32,768 nodes counted over the parsed tree in one linear pass, so
  duplicate keys collapse as JavaScript does). The frame is the redacted line as received, a
  response's `data` settles as its raw JSON text, and a dialog is stored as its raw text keyed by
  its exact JavaScript id. No typed or depth-limited decode runs in the wire.
- **Byte feeds and framing.** `PiWire::stdout_bytes` and `stderr_bytes` own both framers (elision
  then `JsonLines` on LF/CRLF for stdout; `DroppingGate` on CR/LF for stderr) and return the
  resulting effects; `finish` is the only place the framers end. E3-pi.2's
  `OutputConsumer::output` hands each chunk to the matching feed and must not frame it again (no
  elision, `JsonLines` or gate in `io.rs`).
- **Tests**: the tables in `session/wire/tests.rs` cover the 64 cap and seq, the exact frame and
  queue byte bounds, one settlement and one charge release across ack/failure/close, dialog and
  rollback effect order, chunked framing through drain, and payload admission (byte, structural,
  deep and lone-surrogate cases); E3-pi.2's files prove the wiring.
- **Must not**: spawn, read the clock, set a timer or touch the filesystem; use `serde_json`;
  change `translate/`; turn any `Uncertain` into a `Refused`.
- **Reviewer checks**: diff each method against its TypeScript lines; every message is today's
  string; a failed validation leaves no state; `stdin_error` settles uncertain; redaction comes
  before every `Frame`, and `Write` carries the original bytes.

#### E3-pi.2 The Pi binding, facade and switch

- **Files**: `native/daemon/crates/ace-adapter-pi/src/session/io.rs` (new: the tokio side),
  `ace-daemon-node/src/session_pi.rs`, `packages/adapter-pi/src/native-session.ts`,
  `packages/adapter-pi/src/session.ts` (one line, step 9). Nothing else.

Steps, in order:

1. `io.rs`: `PiSessionCore { wire: Mutex<PiWire>, queue: EventQueue, gate: ReadGate, ports: Arc<OnceLock<ChildPorts>> }`.
2. **One input, one lock.** Every input, whether it comes from tokio (`OutputConsumer` calls) or
   from JS (binding calls), runs as: lock `wire`; call the one `PiWire` method; hand each `Write`
   effect to `ports.stdin.write` in order; convert the other effects to `SessionEvent`s and
   `queue.publish` them; unlock. Nothing else touches `wire`. If `ports` isn't set yet or
   `ports.stdin.write` returns `Err`, call `wire.write_refused()` before unlocking and publish its
   effects with the rest, so the request settles through the queue and the binding call still
   returns normally.
3. **`OutputConsumer` for `PiSessionCore`**:
   - `output(Stdout | Stderr, bytes, delivered)`: hand the bytes to the wire's `stdout_bytes`
     (stdout) or `stderr_bytes` (stderr) — the wire already frames them, so do not frame again —
     then call `gate.answer(delivered)`, which checks and pauses in one step (E3.0c, step 2).
     When the gate later opens, it resumes the stream.
   - `stdin_written()` → `wire.stdin_written()`; `stdin_error(e)` → `wire.stdin_error(&e.message)`.
   - `exit(_)`: call `gate.exited()`, then publish `ArmTimer { key: "cutoff", ms: 1000 }`.
   - `end(_)`: nothing; an end is not the barrier.
   - `close(_)`: `wire.finish()`, the terminal barrier. It ends with `Drained`.
4. **The terminal barrier and the inherited-pipe cutoff.** Only the supervisor's `close` ends
   the stream: it fires after both pumps have ended (`child/mod.rs:243`–`:273`). So stderr's EOF,
   or stdout's, never closes the queue while the other stream or the leader's exit still has
   frames to give, and the last reply, dialog or turn event always reaches the engine before
   `onExit` (behaviour.md §8, `:296`–`:300`). If a descendant keeps a pipe open, `close` never
   comes on its own. When the `cutoff` timer fires (1,000 ms after the leader's exit, today's
   drain, `session.ts:272`–`:283`), `timer("cutoff")` calls `ports.output.close` on both
   streams. Each pump stops, emits `end` (E3.0b, step 2b, so the JS readables end too), and
   `close` follows with whatever was read; nothing already read is dropped. If `close` came first, `CancelTimer { key: "cutoff" }` is part of
   `finish`'s effects.
5. **Binding** (`session_pi.rs`):

   ```rust
   #[napi] pub struct PiSessionNative { core: Arc<PiSessionCore>, port: SessionPort }
   #[napi] impl PiSessionNative {
       #[napi(constructor)] pub fn new(config_json: String, events: ThreadsafeFunction<String, ()>) -> napi::Result<Self>;
       #[napi] pub fn output_target(&self) -> NativeOutputTarget;
       /// Refusals throw an Error with code ACE_PI_COMMAND_REFUSED; nothing else throws.
       #[napi] pub fn request(&self, command: String, params_json: String, id: u32) -> napi::Result<()>;
       #[napi] pub fn write(&self, data_json: String, id: u32, resume_after: bool) -> napi::Result<()>;
       #[napi] pub fn note(&self, json: String);
       #[napi] pub fn timer(&self, key: String);
       #[napi] pub fn peek_dialog(&self, id: String) -> Option<String>;
       #[napi] pub fn take_dialog(&self, id: String) -> bool;
       #[napi] pub fn dialog_count(&self) -> u32;
       #[napi] pub fn expect_rollback(&self, id: String);
       #[napi] pub fn rollback_result(&self) -> Option<bool>;
       #[napi] pub fn clear_rollback(&self);
       #[napi] pub fn set_paused(&self, paused: bool);
       #[napi] pub fn fail(&self);
       #[napi] pub fn drain(&self);
       #[napi] pub fn undrain(&self);
       /// No child will ever report (the spawn threw): close the wire and publish Drained now.
       #[napi] pub fn abandon(&self);
   }
   ```

   Every export uses `catch_unwind`. JSON crosses only as text (the store guide's rule on lone
   surrogates).

6. **Facade** (`native-session.ts`): `export async function openNativePiSession(ctx, options): Promise<PiSession>`.
   Copy `openPiSession` (`session.ts:55`–`:505`) and make only these replacements:
   1. `rpc` becomes a local object. `request(command, params)` takes the next id, calls
      `handle.request` synchronously (a throw becomes `Promise.reject(new PiCommandRefused(message))`)
      and returns `bridge.expect(id)`. `write(data)` does the same with `resume_after: false`.
   2. `io.spawn({...same options..., nativeOutput: handle.outputTarget()})`. Leave `maxLineBytes`,
      `elideStdout` and `onStderrLineDropped` in the call: they take no effect on a diverted
      child, and the Rust framers apply the same numbers. **If `io.spawn` throws** (the catch at
      `:153`–`:158`), no child will report, and whether or not the native child briefly existed
      only JS saw its end. So call `handle.abandon()` (the wire closes and `Drained` is published
      at once; any late consumer event after it is dropped by `publish`), run today's cleanup
      (`configuration.remove()`, `lifetime.abort()`, `lease?.end()`) and rethrow. Nothing on this
      path awaits `drainedPromise`.
   3. `emit` and `note` call `handle.note(JSON.stringify(...))`. The facade never calls
      `ctx.onFrame`; the bridge does.
   4. Delete the `PiRpc` frame callback (`:217`–`:259`), `stderrLines` (`:261`–`:265`) and the
      drain (`:266`–`:283`); Rust does all three.
   5. `dialogs.size` becomes `handle.dialogCount()` (in `idle`, `:328`). `resolve`
      (`:430`–`:445`) keeps today's order (validate, then consume, then write):
      1. `const dialog = handle.peekDialog(id)`; if it is `undefined`, throw
         `Error("Pi dialog is no longer pending")` (`:432`–`:433`);
      2. `const response = dialogResponse(JSON.parse(dialog), resolution)`. If this throws, the
         dialog stays pending and untouched, as today (`:434`);
      3. `if (!handle.takeDialog(id))`, throw the same "no longer pending" error. This is the
         reservation (`:435`–`:436`): of two devices answering at once, only one gets it;
      4. `handle.write(JSON.stringify(response), writeId, true)`, then
         `await bridge.expect(writeId)`. Deadlines resume inside the wire, only after the
         successful write and only when no dialog is left. On failure, call `fatal()` and
         rethrow, as today (`:441`–`:444`).
   6. `rollbackAck` becomes `handle.expectRollback(id)` and `handle.rollbackResult()`, and the
      `finally` (`:499`–`:502`) calls `handle.clearRollback()`.
   7. Register `{ ACE_PI_COMMAND_REFUSED: PiCommandRefused, ACE_PI_UNCERTAIN: Error }` with the
      bridge. `send`'s `catch` (`:413`–`:421`) stays word for word, so a refusal before acceptance
      is `InputRejected` and an uncertain failure is rethrown, as today.
   8. `hooks.fatal` is today's `fatal` (`:214`–`:216`).
   9. `hooks.drained` awaits `proc.exited` and then calls
      `ctx.onExit({ deliberate, message: \`Pi process ${exit.reason}, code ${exit.code}\` })`.
      Nothing follows it.
   10. **Hooks that need `proc`.** `proc` is assigned only once `io.spawn` returns. Keep a
       `let spawned = false`, set to `true` on the line after that assignment. `hooks.fatal`
       and `hooks.drained` both begin with `if (!spawned) return;`. So the `Drained` that
       `abandon()` publishes on the spawn-failure path (step 6.2) settles the bridge's promises
       and timers and calls no hook that touches `proc`, and `ctx.onExit` is not called: the
       open rejects instead, as today when the spawn throws.
   11. If `ACE_SESSIONS_EVIDENCE` is set, append the evidence line of E3.0d step 3 once the open
       succeeds.
7. **Close, replacing `session.ts:285`–`:297`.** Today's order (release, close the RPC, then
   stop) leaves an unusable session if the stop fails. The native close is retryable and tears
   down only after the stop is confirmed:
   1. If a close is in flight, return its promise.
   2. Set `closing = true` and `deliberate = expected` (keep the previous values). `check()` now
      refuses new commands with `"Pi session closed"`, as today. Call `handle.drain()` (the
      cancellation of ADR 0223 §7 rule 4). Do not call `release()`, `rpc.close()` or detach
      anything yet.
   3. Stop. POSIX: `proc.stop({ graceMs: 1000 })`. Windows: don't call `stopTreeAfterEof` or
      the cached `stopTree` (`:65`–`:68`). Compose the same steps from `@ace/provider-kit/tree-stop`
      so a retry keeps the first attempt's record:
      1. on the first attempt only, `firstTree = recordTree(proc.pid)` while the leader is alive,
         then `proc.stdin.end()`;
      2. on every attempt, if the leader is still alive, push `recordTree(proc.pid)` onto
         `trees: RecordedTree[]` (which starts as `[firstTree]`). It is a new snapshot that may
         name descendants started since. `trees` lives for the session: no snapshot is ever
         dropped, whether its attempt succeeded or failed;
      3. `await proc.stop({ graceMs: 1000 })`, then `await tree.end()` for every tree in
         `trees`, oldest first. A `RecordedTree` can be ended again, and it keeps the members it
         proved (`tree-stop.ts:105`–`:125`), so every attempt stops the union of every snapshot
         taken so far, including descendants found only by an earlier failed attempt after the
         leader has exited.
   4. If the stop rejects: clear the in-flight promise, restore `deliberate`, call
      `handle.undrain()` (E3.0c: the gate's state before the drain comes back exactly, and a
      latched failure stays failed), and reject with the stop's error. **The session is then
      stop-only, not usable.** On Windows stdin is already closed and can't be reopened, and on
      POSIX signals have been sent, so `closing` stays `true`. **No write follows a failed
      stop.** `check()` refuses commands, and `resolve()` refuses as well: replace its
      `checkOpen()` (`session.ts:431`) with a `checkWritable()` that throws
      `Error("Pi session closed")` when `closed` or `closing` is set, and otherwise does what
      `checkOpen()` does. `fork` and `rollback` already go through `check()`. The handle, its
      queue, the dialogs, `trees` and the child are untouched, so
      frames still reach the engine, the engine can give the session back
      (`engine/sessions.ts:1064`–`:1069`), and the only thing a later `close` does is try the
      stop again (step 3).
   5. If the stop resolves: `await bridge.drainedPromise` (every frame the child produced has been
      delivered), then `release()`, then resolve. `close()` resolves only after the drain.
      The `proc.exited` handler (`:304`–`:310`) keeps `closed = true` and `release()`, because a
      process that exits on its own is gone either way.
8. Write the open's error path (`:360`–`:371`) the same way: stop, `await bridge.drainedPromise`,
   then close and rethrow. This path exists only after `io.spawn` returned, so a child exists and
   its `close` (or the cutoff) brings `Drained`. A spawn that threw is step 6.2's path.
9. The switch, the one line in `session.ts`, as the first statement of `openPiSession`:
   `if (sessionBackend("pi") === "native") return (await import("./native-session.ts")).openNativePiSession(ctx, options);`

- **Invariants** (behaviour.md): §8, identity before echo (Pi has no `onSessionIdentity`; the
  reference is saved before the open returns, as today), and the exit after every frame (step 4);
  §10, check and admission in one step; §12, the stop plan stays TypeScript, and an unconfirmed
  close leaves the session whole (step 7); §14, raw is post-redaction, so the control secret and
  the lease bearer never reach a frame; §15, the child is owned, journaled and stopped by
  TypeScript as today.
- **Proof** (each alone, in the three modes): in `packages/adapter-pi/src/`, `session.process`,
  `catalog-input.process`, `delegation-context.process`, `fork.process`, `history.process`,
  `input-rejected.process`, `permissions.process`, `shim-session.process`, `skills.process`,
  `system-prompt.process`, `tool-exposure.process`, `tool-listing.process`,
  `extension.process`; in `apps/daemon/src/engine/`, `adapter-echo.process`,
  `attachment-echo.process`, `provider-context-meter.process`, `provider-permissions.process`;
  and `apps/daemon/src/provider-availability.process.test.ts` and
  `provider-mcp.process.test.ts`, each with `ACE_SESSIONS=pi`.
- **Bench**: `bun apps/daemon/bench/session-stream.ts`, all four modes, with E3.0d's rule.
- **Must not**: change `session.ts` beyond the one line; edit any test or `testing/` file; move
  `extension.ts`, `extension-api.ts` or `extension-mcp.ts`; set a Rust timer; release anything
  before a stop is confirmed.
- **Reviewer checks**: a hunk-by-hunk diff of `native-session.ts` against `session.ts` shows
  only the replacements above, plus step 7's close; a failed stop leaves the session whole but
  stop-only (`request`, `resolve` and every other write refuse, frames still flow, and a retried
  close ends every tree in `trees`); a
  successful close resolves after `Drained`; no frame is built outside the bridge; the files
  pass in all three modes.

#### E3-pi.2b The Pi restart test and its cross-mode run (owner decision 1)

No test reboots a home with a Pi thread, so the owner allows one new test for it.

1. Create `apps/daemon/src/engine/pi-restart-resume.process.test.ts`. Its header says why: no
   test covered a Pi thread resumed across boots of one home, so the E3 cross-mode gate had
   nothing to run for Pi.
2. Build it the way `codex-admission-restart.process.test.ts` does (`harness` from
   `./test-support.ts`). **Do not use `restart()`** from `recovery-test-support.ts:48`: it reuses
   `h.store`, so the event database never reopens, no boot is recorded and the backend never
   switches. For each reboot, do what `codex-admission-restart.process.test.ts:60`–`:62` does:
   `await engine.close()`, close the store, then `store = new Store(h.path)` and
   `engine = new Engine(store, { registry: h.registry, clock: h.clock })`. Opening the store is
   the boot (`noteDatabaseBoot`). Close the last engine and store in `finally`. Use
   `createPiAdapter` with a `runtime.spawn` that runs `packages/adapter-pi/src/testing/fake-pi.ts`,
   as `testing/harness.ts:120`–`:128` does, and give the fake its home through `FAKE_PI_HOME`.
   Before boot 0, seed that home as `testing/harness.ts:62`–`:67` does:
   `await writeFile(join(home, "source.jsonl"), sessionFixture(home, "native", 3))`, with
   `sessionFixture` from `packages/adapter-pi/src/testing/native-history.ts`. Without it the fake
   loads no history, and on each reboot Pi's resume finds nothing valid to check
   (`checkedSessionReference`, `session-header.ts:58`–`:66`).
3. The test: boot 0 starts a Pi thread and completes one turn, then records the thread's stored
   native session id. Then **two** restarts, boots 1 and 2. After each one:
   1. the thread's stored native session id is unchanged;
   2. the reopened session resumed it. The fake loads `source.jsonl` at every start
      (`testing/fake-pi.ts:18`), so matching ids alone prove nothing. Pi frames are not
      persisted (the Cursor-only journal, `repository.ts:725`–`:731`), so record each frame only
      after the commit `ctx.onFrame` returns has resolved: a frame counts only once the engine
      ingested it. From those frames assert a `send` frame
      `{ type: "switch_session", sessionPath }` whose `sessionPath` is boot 0's `sessionFile`,
      answered `{ cancelled: false }`, followed by a `get_state` reply with the same
      `sessionFile` and `sessionId` as boot 0 (the restore of `session.ts:332`–`:341`);
   3. a new message to the thread produces a reply and the thread settles, so the continuation
      works. After each boot, read back through the Store's public thread reads each stored
      reply, its settled run and the native session id committed with them.
      Under `ACE_NATIVE_CROSS=ACE_SESSIONS`, boots 0, 1 and 2 alternate backends, so both swaps
      (native→TypeScript and TypeScript→native) are checked in one run.
4. The file is allowlisted already: it is the Pi cross-mode list below, and ADR 0223 §8's E3
   list names it. Don't edit either list. If it goes over the 30 s process budget, add it to
   `scripts/test-budgets.json` with this reason.

- **Boots**: the test itself asserts three boots of its root. When `ACE_NATIVE_CROSS_LOG` is
  set, it reads the log and expects three lines for the home, with `n` 0, 1 and 2 and
  alternating backends.
- **Run**: alone, off and in the three modes, then
  `ACE_STORE=native ACE_SUPERVISOR=native ACE_STORE_ADDON=$A ACE_SUPERVISOR_ADDON=$A ACE_SESSIONS_ADDON=$A bun scripts/native-cross.ts ACE_SESSIONS apps/daemon/src/engine/pi-restart-resume.process.test.ts`
  with `ACE_SESSIONS=pi`. The gate asserts that one root booted three times with alternating
  backends.
- **Pi cross-mode list**: `apps/daemon/src/engine/pi-restart-resume.process.test.ts`.
- **Must not**: add a second new test; edit any existing test.
- **Reviewer checks**: the test fails if the resumed id differs, if the fake starts a fresh
  session, or if the continuation never replies; the gate's log shows both swaps.

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

Later, not part of the pilot (owner decision 4). Briefed here so the pilot's interfaces fit it;
reviewed again before any of it is built.

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
- **Tests**: Rust unit tables cover the peer's limits, ids and effect ordering; E3-codex.5 and
  E3-acp.3 prove it through their session files.
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
- **Effects, published in order**: every input's effects join one queue under the host's lock and
  one caller at a time hands them to the shell (`HostSink`), so two inputs never swap the effects
  they decided: a settlement a timer decided is never published after the exit a pipe close decided
  later, and no frame is published before the settlement decided before it (ADR 0223 §7 rule 3,
  `bridge.rs`). The shell sets its sink once, before its first input. Only admission is decided
  under the lock (`ChannelHandlers::admit`: a refused frame mutes its channel and is never
  dispatched); every callback a channel can observe is an effect in that same order: the frame,
  its notification or server request, the refusal, a dropped line, a malformed line, a diagnostic
  and the host's failures (`Host::hand_over`), and a server request's answer goes back through
  `answer`/`answer_error` so the reply keeps the order too.
- **A sink that unwinds poisons the host**: a panic in the shell is a bug, not a protocol event,
  so the drain catches it once. The host stops the child directly, never through the queue
  (`HostSink::stop`), taking a stop already queued out of the order so a delivery that panicked
  cannot lose it; a stop is owed only when one was decided (the unwinding effect itself, or one
  still queued), never for a child whose pipes closed (a leader's exit leaves a tree holding them,
  and the supervisor never signals on it, `ace-supervisor/src/child/mod.rs:5`–`:8`). One stop at a
  time, by generation: a retire that
  arrives while it is in flight joins it, a landed one is not repeated, and only a stop the shell
  could not confirm leaves the host stoppable, its owner's next retire handing the child another. Effects already decided keep their place, and only what the poison
  decides is appended — a failure for each call still pending and an exit for each channel without
  one — so every call ends with exactly one settlement or failure and every channel with one exit.
  A write still queued is dropped, since the call its line carried has failed. After that each
  delivery has its own catch: a second panic skips that effect, logs it and continues. TS has no
  equivalent (`behaviour.md` §15): a throwing callback there is an uncaught error. Nothing here may
  reintroduce `RpcPeer::write_failed`: a submitted write whose callback unwinds is the shell's, and
  the host's cleanup never waits on it.
- **A served request keeps its reply until it is answered**: the host records the tenant that was
  served when it queues the dispatch and keeps that attribution until the answer arrives (freed at
  the host's exit). A reply produced after its channel closed is dropped silently, as TS does:
  `#sent` (`host.ts:437`) ignores what a closed tenant refuses (`deliver`, `host.ts:169`), and the
  router forgets the attribution at release (`host-routing.ts:81`).
- **A backlog closes the gate**: every effect is measured as it is queued, so a single input that
  releases a hold above the byte budget closes the gate too; an effect that waits behind another
  input stays in that queue,
  and once it holds TS's intake budget — 256 entries or 4 MiB, reopened below 64 and 1 MiB
  (`apps/daemon/src/engine/actor.ts:84`–`:103`, `apps/daemon/src/engine/limits.ts:9`–`:17`; TS
  counts frames, the host counts every payload-bearing effect so diagnostics and malformed lines
  cannot pile up either) — the host closes its read gate, so a stalled shell never lets the
  child's pumps read into an unbounded queue.
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
  retirement reasons are `host.ts:49`'s set; no input publishes its effects on its own thread.

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
  `nativeSessionId` and `sessionConfirmed` are synchronous getters.
- **Close** ports `sessionLifetime`'s `stop` (`session-lifetime.ts:41`–`:78`) branch for branch,
  in Rust:
  1. no channel, or the host already exited: clean up and resolve;
  2. a shared host on which this tenant is alone and busy (turns, shells or uncertain output,
     `busy()`, `session.ts:413`): clean up and retire the host; resolve only once its exit is
     confirmed;
  3. a shared host with other tenants while this one is busy: stop this tenant's work
     (`stopWork`: the root interrupt with `cascade: true`, each request bounded at 10 s,
     `session.ts:416`–`:423`) and confirm that its turns and shells have stopped. If that
     can't be confirmed, retire the host instead: unconfirmed work is never left running
     unobserved (`session-lifetime.ts:64`–`:74`);
  4. otherwise, detach the tenant.
     `close` resolves only when its branch is confirmed. On failure the tenant stays attached and
     whole (rule 5).
- **Open conflict, to fix when Codex is scheduled.** Branches 2 and 3 call `cleanup()` (pending
  rejected, maps cleared, timers cancelled) before `retire()` is confirmed, as the TypeScript
  does (`session-lifetime.ts:61`–`:73`). That contradicts keeping the tenant whole when the
  retirement fails. Re-brief the order (clean up after confirmed retirement) before E3-codex is
  built.
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

Later, not part of the pilot (owner decision 4).

#### E3-acp.1 Session core and capture

- **Files**: `native/daemon/crates/ace-adapter-acp/src/session/`, file by file: `mod.rs` the
  module surface; `core.rs` the sans-IO session over the peer, its frame capture and the
  settlement that runs in frame order; `frames.rs` payload capture (redaction, byte and node
  bounds, binary elision); `routing.rs` children, owners and their cancellation; `deadlines.rs`
  the named deadlines over the facade's timers; `negotiation.rs` ACP version negotiation and the
  compatibility profiles; `configuration.rs` effective capabilities, selectors and selection
  replies; `open.rs` the `initialize` and `session/new|load|resume` handshake; `selections.rs`
  the saved mode, model and effort applied before the open settles; `io.rs` the diverted-child
  I/O shell; `shells.rs` the session's shell settlement over the translator's; `mcp.rs` MCP
  server selection, transport filtering and collision checks; `selectors.rs` the
  agent-registry selector port; `identity.rs` the translator identity; `quirks.rs` the provider
  quirks and CLI version gates; `resume_error.rs` resume failure classification; and the tests
  beside them (`tests.rs` plus each file's own `mod tests`).
- **Ports**: `session.ts`'s `AcpSession` (`:118`–`:940`), the frame capture (`:361`–`:381`)
  through the E1 port of `frame-redaction` (`translate/frame_redaction.rs`) and binary elision,
  settlement in frame order inside the peer's frame callback (`:200`–`:212`; a continuation after
  an await would run too late, `:203`–`:204`), `session-routing.ts`, `deadlines.ts`,
  `negotiation.ts`, `bridge-negotiation.ts`, `configuration.ts` (its (b) cases move),
  `quirks/{types,generic,antigravity}.ts`, `provider-kit/cli-versions.ts`,
  `mcp-server/injection.ts` (its `appendAcpMcp`, the transport filtering and ace's injected
  servers), `agent-registry/selectors.ts`, `provider-kit/{permission,access}-modes.ts`,
  `identity.ts`, `resume-error.ts`, over the E3-codex.1 peer and a diverted child.
- **Crate**: remove `agent-client-protocol` from `ace-adapter-acp/Cargo.toml` and
  `Cargo.lock` (no code uses it, owner decision 3). Define `PROTOCOL_VERSION` and the
  `AGENT_METHODS` names the TypeScript uses in `session/protocol.rs`, copied from
  `@agentclientprotocol/sdk` 1.7.0 (`adapter-acp/package.json:20`), with a comment naming that
  version.
- **Must not**: add any ACP crate; change `translate/`.

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
5. Rule 5: `close` resolves only on confirmed exit and after `Drained`; on rejection nothing is
   released, and the handle, its queue and the child stay whole for a retry.
6. Redaction before every `Frame` effect; wire bytes are the original.
7. No Rust timer or clock in protocol logic; `t` from the injected `now`.
8. The proof files pass alone in all three modes, the cross-mode list both ways, the (b) cases
   are moved one for one, and the bench numbers are in the PR.

### Owner decisions (E3, 2026-11-23)

1. **Pi restart.** One new test is allowed for the Pi cross-mode check, because nothing covers
   it: E3-pi.2b.
2. **Default-on.** A session defaults on only if the session bench shows it no slower than
   everything off (E3.0d, step 6).
3. **`agent-client-protocol`.** Kept only if E1's ACP translator already depends on it. It
   doesn't, so E3-acp.1 removes it and defines the two constants locally.
4. **Scope.** Pilot only: E3.0, E3-pi.1, E3-pi.2 and E3-pi.2b now; Codex and ACP later.

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

E5.1's builder brief is [e5-1-brief.md](e5-1-brief.md). It corrects this table's E5.1 row: the
first all-green run of `main-integration.process` is at E5.8 and of `engine.process` at E5.10,
not with E5.2 to E5.4 (they open sessions, deliver, restart and stop background tasks);
`adapters.ts` stays TypeScript. Its step 12 is the test seam and the per-item proof order.

E5.3's builder brief is [e5-3-brief.md](e5-3-brief.md): engine rows on the store's connection,
event rows through the store's writer, migrations staying TypeScript, the lazy record section in
`ace-core`, and the sliced startup scan.

E5.2's builder brief is [e5-2-brief.md](e5-2-brief.md). It corrects this table's E5.2 row:
`signal-batching`, `sdk-burst`, `streaming-behaviour` and the storage row open real sessions, so
they are first green at E5.6, not with E5.2. E5.2's own proof is the seam and its Rust tests. It
also fixes the `ActorRepo` and `ActorLinks` traits that E5.3 to E5.10 implement for the actor.

E5.4's builder brief is [e5-4-brief.md](e5-4-brief.md). It splits E5.4 into six rounds (E5.4a to
E5.4f) and corrects this table's E5.4 row with the owner's decisions of 2026-11-24:
`person-command` stays TypeScript (the facade's normalization); `readMessageFacts` moves to E5.5;
E5.4 ports the synchronous receipt dependencies its "receipt dependencies" table lists, which drop
from the E5.5 to E5.10 rows while their execution stays there; it amends E5.1 with three
synchronous ports and one probe hook; and most of the commands row first passes natively at E5.6
or later, as its proof table says.

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
