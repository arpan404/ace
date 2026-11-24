# E5.4: commands, intents, queue and inputs in Rust (switch `ACE_ENGINE=native`)

Part of the [engine porting guide](porting-guide.md). Its rules 1–16, "Files per work item" and
"For every E5 item" apply unchanged, and so does the [E5.1 brief](e5-1-brief.md): its decisions,
its facade kinds (R, M, A, H, B), its re-entrancy rules and its test seam (step 12), as amended
below. The [E5.3 brief](e5-3-brief.md) fixes the `Repo` API, the
fold's collaborator traits and the opener this brief builds on. Where this brief is more exact, it
wins for E5.4. Read
[ADR 0223](../adr/0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md) §4, §5
and §8, [ADR 0053](../adr/0053-queue-and-recovery.md) (the queue, holds and recovery, with its
amendments of 2026-10-15, -17 and -18), [ADR 0170](../adr/0170-daemon-never-blocks-on-history-sized-work.md)
and [behaviour.md](behaviour.md) §3, §9, §10 and §17 first. TypeScript paths are in
`apps/daemon/src/engine/` unless they say otherwise. Line numbers are as of
`origin/ace/daemon-rust-rewrite` a9229d6400.

E5.4 ports what happens between a command arriving and its work being picked up: the receipt
(`handler.handle`, synchronous inside the receipt transaction), creation admission and
validation, the durable intents and the queue, the input journal and the transcript's input
items, ace's own inputs, and the sends worker's choice of what to deliver next. It delivers
nothing: claiming an intent and calling the provider is E5.5, and opening sessions is E5.6.

It lands as six builder rounds, **E5.4a to E5.4f**, each under about 2,000 lines of Rust (tests
included), each behind the one switch, each leaving the switch-off path byte-identical, and each
with a seam test it can reach when it lands.

Revised 2026-11-24 after review (gpt-6.2-sol, high) and the owner's decisions:

- the rounds were re-cut so that every round reaches its own seam test, and E5.3's fold hooks
  are now 4a's and 4b's;
- the synchronous receipt dependencies of later items are ported;
- three daemon services are synchronous TypeScript ports, written here as an amendment to E5.1;
- creation keeps the catalog-backed model calls and tells an absent owner from an unknown one;
- every receipt side effect is commit-scoped;
- refusals that commit earlier writes are named;
- the open-time scans follow the E5.3 brief's prerequisite fix on main, and a second main fix
  ("Main fixes E5.4 depends on") makes title naming commit-scoped in TypeScript too;
- the Stop test asserts what TypeScript does.

## Decisions

1. **The synchronous receipt dependencies are ported, wherever their module lives** (owner
   decision 1). A receipt that reaches an unported function fails and rolls back. So every
   function that an ordinary receipt (create, prepare, send, Stop, archive, every queue command)
   or the sends worker calls synchronously is ported by E5.4. That includes switch admission for
   a selecting steer and guard release for a Stop. E5.4 writes them in their owners' files, which
   is safe because E5.5 to E5.10 start after E5.4f. **Execution stays with the owning items**:
   delivery, session opening and closing, transition execution, deadline firing, and readiness
   capture by the fold. Commands that are other items' own receipts stay stubs: fork, switch and
   merge (`acceptTransition`, E5.9), permission and mode changes and interaction answers (E5.7),
   and adoption of an imported thread (E5.8). A stub fails
   `EngineError::not_ported(<what>, <item>)`. "The receipt dependencies" lists every function
   and which way it goes.
2. **Command-time holds are 4d's; E5.8 executes deadlines** (owner decision 2). These are
   `Recovery`'s `preferences`, `prepare`, `handle`, `admit`, `withoutRestatedSelection`, `sync`,
   `bindingChanged`, `releaseLimitHold`, `lift`, `owns`, `begin`, `release`, and `schedule`'s
   arming. E5.8 keeps `fire`, `fireOne`, `automatic`, the deferrals, captures and limit
   observation, and calls 4d's functions for the shared parts.
3. **`readMessageFacts` and the `messageFacts` member move to E5.5** (owner decision 3).
   `readyForInput` and `threadCapabilities` stay in 4f for the sends worker.
4. **Six rounds** (owner decision 4) in the order of the table below. 4a and 4b need only E5.1 and
   run alongside E5.2 and E5.3. 4c, 4d and 4e need E5.3's `Repo`. 4f needs E5.2's actor and 4e.
   E5.5 starts after 4f.
5. **E5.3's fold hooks are 4a's and 4b's.** E5.3's `InputFacts` collaborator trait
   (`repository/collaborators.rs`) is how the fold calls into E5.4. Every one of its methods is
   implemented in 4a or 4b, which need no E5.3 code, so the fold never waits on a round that waits
   on E5.3. The trait itself is declared first, in its own small prerequisite ("The `InputFacts`
   declaration", below), so 4a builds without waiting for E5.3. 4a then moves
   `impl InputFacts for State` out of `collaborators.rs` into
   `ace-engine/src/queue/fold_hooks.rs` with its methods, as E5.3's step 7 allows. 4b adds its
   methods to that block. Until each method lands it keeps E5.3's default, an explicit
   `NotPorted` stub naming its round, and E5.3's probe pass-through covers the fold seam meanwhile.
   `rootRunStart` is in E5.3's `InputFacts` list but `root-run-start.ts` is E5.5's module, so E5.5
   implements it, and E5.3's table is corrected to say so.
6. **Daemon services stay TypeScript, as synchronous ports on the shared stack** (owner
   decision 5): `workspaceDirectory`, `portableHandoff`, `linkCreatedThread`. The contract is in
   "Amendments to E5.1". The path keeps `realpathSync`'s spelling on macOS and Windows, because
   the port calls `workspace-directory.ts:3`–`:6` itself.
7. **Pure package helpers on the receipt or frame path go to their owners' crates** (owner
   decision 6), keeping JavaScript's serialization and error bytes exactly. Their TypeScript
   stays (the web app, iOS and the TypeScript adapters use them). No test case is copied: the (a)
   files that reach a helper prove it, and a helper no (a) file reaches gets one cargo test, and
   the commit says so (rule 5).
8. **The DDL stays TypeScript; the open-time data work becomes E5.3's fills.** E5.3's opener runs
   the TypeScript constructors at boot, so every `CREATE TABLE`/`CREATE INDEX` keeps one source
   (E5.3, "Migrations: stay TypeScript"). The data passes those constructors run today move to
   **fills** in the E5.3 brief's "Prerequisite fix on main (TypeScript, its own PR, before
   E5.3)", now on branch `ace/fix-bounded-open-fills`. Each fill is idle, resumable, 256 rows a
   step, with a done signal. E5.3 ports the fill driver and the fills (`repository/fills/`).
   E5.4 ports **the readers' fallbacks** of its own tables (the queue, attachment retention), in
   the bounded form that lands on main, and reads the fill state through `State.repo.fills`.
   "Open-time work" lists every statement.
9. **`personCommand` stays in the shell.** E5.1 step 9 keeps the normalization in
   `native-engine/engine.ts`, so `person-command.ts` is not replaced, and the `admitCreation`
   facade calls it before the binding as well.
10. **Never edit E5.2's or E5.3's files**, except the one move of `impl InputFacts for State` that
    E5.3's step 7 allows. What E5.4 needs from `Repo` it calls through E5.3's API. If a method is
    missing, ask for it in E5.3's review.

### The `InputFacts` declaration (a prerequisite for 4a and for E5.3's step 7)

4a moves an `impl` of a trait that E5.3 owns. 4a runs alongside E5.3, so the trait has to exist
before either starts. It lands as a **declaration-only commit on `ace/daemon-rust-rewrite`**,
reviewed by E5.3's and E5.4's reviewers, before 4a and before E5.3's step 7. Whichever builder
starts first writes it. It contains:

- `ace-engine/src/repository/collaborators.rs` with the `InputFacts` trait only. E5.3 adds its
  other five traits in its own step 7. Every method has a default body returning
  `Err(EngineError::not_ported("<method>", "E5.4a"))`, or `"E5.4b"`, or `"E5.5"` for
  `root_run_start`, as the tables in "Module map" assign it. The file ends with
  `impl InputFacts for State {}`. So the crate builds and every fold call fails `NotPorted` until
  its owner lands.
- The data types the signatures name, as plain structs with no behaviour:
  - `IntentHeader` in `intents/header.rs`, with the fields of `intents.ts:9`–`:24`;
  - `RecoveryRecord` and `RecoveryPatch` (every field optional, `null` kept distinct from
    absent) in `queue/record.rs`, with the fields of `queue-store.ts:19`–`:28` and `QueueState`.
    These files are E5.4's; 4a fills in their decoding and rules.
- The signatures. Every method takes `&self` (the `State`) and the open `&Tx`, unless it is pure:

```rust
pub trait InputFacts {
    fn correlate(&self, tx: &Tx, thread: &ThreadId, fact: Fact, root: &str, generation: Option<u32>) -> Result<Option<Fact>, EngineError>; // 4b
    fn key_for(&self, tx: &Tx, thread: &ThreadId, native_id: &str) -> Result<Option<String>, EngineError>;                                 // 4b
    fn attribute(&self, tx: &Tx, thread: &ThreadId, fact: Fact) -> Result<Fact, EngineError>;                                              // 4b
    fn ace_wait_fact(&self, state: &ThreadState, fact: &Fact) -> Result<Option<Fact>, EngineError>;                                        // 4b
    fn bind_started_run(&self, tx: &Tx, state: &mut ThreadState, run: &RunId, generation: Option<u32>) -> Result<Vec<EventPayload>, EngineError>; // 4b
    fn bind_consumed_input(&self, tx: &Tx, state: &mut ThreadState, key: &str, generation: Option<u32>, at: i64) -> Result<Vec<EventPayload>, EngineError>; // 4b
    fn handed_over(&self, tx: &Tx, thread: &ThreadId) -> Result<Option<IntentHeader>, EngineError>;                                       // 4a
    fn uncertain_continuation(&self, tx: &Tx, thread: &ThreadId) -> Result<Option<IntentHeader>, EngineError>;                            // 4a
    fn resolving_interactions(&self, tx: &Tx, thread: &ThreadId) -> Result<IndexSet<InteractionId>, EngineError>;                         // 4a
    fn finish_continuation(&self, tx: &Tx, thread: &ThreadId) -> Result<(), EngineError>;                                                 // 4a
    fn awaiting(&self, tx: &Tx, thread: &ThreadId) -> Result<Option<IntentHeader>, EngineError>;                                          // 4a
    fn queue_get(&self, tx: &Tx, thread: &ThreadId) -> Result<RecoveryRecord, EngineError>;                                               // 4a
    fn queue_set(&self, tx: &Tx, thread: &ThreadId, patch: RecoveryPatch, at: i64) -> Result<(), EngineError>;                            // 4a
    fn queue_prune(&self, tx: &Tx, intent: i64) -> Result<(), EngineError>;                                                               // 4a
    fn queue_has_uncertain(&self, tx: &Tx, thread: &ThreadId) -> Result<bool, EngineError>;                                               // 4a
    fn retire_ended_turn_inputs(&self, tx: &Tx, thread: &ThreadId, generation: u32, at: i64) -> Result<(), EngineError>;                  // 4a
    fn goal_change(&self, current: Option<&ProviderGoal>, next: Option<&ProviderGoal>) -> Result<GoalChange, EngineError>;                 // 4a
    fn root_run_start(&self /* E5.3 fixes the arguments from provider-facts.ts */) -> Result<(), EngineError>;                           // E5.5
}
```

`GoalChange` is `Unchanged | Clear | Set(ProviderGoal)`, for `goal-change.ts`'s
`undefined | null | goal`. If E5.3's fold needs a different argument (the step 7 call sites
decide), E5.3's reviewer changes the signature in this commit, before either builder relies
on it.

After this commit, 4a and E5.3 build independently. 4a's first commit moves the
`impl InputFacts for State` line into `queue/fold_hooks.rs` and overrides its methods there.
E5.3 never touches the `InputFacts` block again.

## The rounds

| Round                                                  | What it ports                                                                                                                                                                                                                                                                                                             | Rust (`ace-engine/src/`)                                                                                                                                                                  | Needs        | Facade members                                                                                  | Seam test it reaches                                                               | Est. lines |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| **4a** intents, queue store, steer notes, fold hooks I | `intents.ts`, `queue-store.ts` (statements, not DDL), `steer-notes.ts`, `stale-inputs.ts`, `snooze-wake.ts`, `input-fate.ts`, `input-delivery.ts`, `edited-context.ts`, `goal-change.ts`; the repository's intent and queue delegations; `boundedJson`; the queue readers' fill fallbacks                                 | `intents/`, `queue/{record,store,page,wake,stale,fold_hooks}.rs`, `steering/notes.rs` (owner E5.5), `inputs/fate.rs`, `rules.rs`                                                          | E5.1         | `queue`, `queuePage`, `commandFailure`, `commandExecution`, `prioritizeSubagentResult`          | TypeScript-written home reads; `probe.inputFacts` stale retirement                 | 1,800      |
| **4b** input journal, input text, fold hooks II        | `input-journal.ts`, `ace-input-attribution.ts`, `ace-inputs.ts` (`attribute`, `get`), `ace-waits.ts`, `bindStartedRun`, `bindConsumedInput`, `bindItemRun` (`transcript-inputs.ts:157`–`:226`); the input-text helpers                                                                                                    | `inputs/{journal,origin,signature,runs,ace,ace_waits}.rs`; `ace-adapter-claude/src/input.rs`, `ace-adapter-pi/src/input.rs` (parts named)                                                 | E5.1         | none                                                                                            | `probe.inputFacts` correlation and run binding on a TypeScript-written home        | 1,600      |
| **4c** transcript inputs and storage dependencies      | the rest of `transcript-inputs.ts`; `ace-inputs.ts` `record`; `title-input.ts`; `thread-posts.ts`; `provisionalTitle`; and the receipt's storage reads and writes of `session-metadata`, `transition-state`, `transition-readiness` (reads) and `permissions` (`ensure`)                                                  | `inputs/{transcript,title,posts,provisional_title}.rs`; `sessions/metadata.rs` (E5.6), `transitions/{state,readiness}.rs` (E5.9), `access/storage.rs` (E5.7)                              | E5.3, 4a, 4b | `inputFate`                                                                                     | `inputFate` precedence on a TypeScript-written home                                | 1,800      |
| **4d** queue commands, holds, steer admission, Stop    | `queue-commands.ts`; `Recovery`'s command path; `guest-admission.ts`; the receipt's prelude (`handler.ts:55`–`:123`); `steer-selection.ts`; `switch-admission.ts`'s `resolveSwitch` and `recordSwitch`; `stop-intents.ts`; `stop-scope.ts`'s `targetsRoot`; `transition-state`'s `releaseGuards`                          | `queue/{commands,holds}.rs`, `commands/{mod,prelude,guest}.rs`; `steering/selection.rs` (E5.5), `transitions/switch_admission.rs` (E5.9), `liveness/{stop_intents,stop_scope}.rs` (E5.10) | E5.3, 4a–4c  | `handler`/`internalHandler` (prelude and queue commands), `admissionReopened`, `prepareCommand` | queue commands, refusals, steer fallback and rollback on a TypeScript-written home | 1,900      |
| **4e** thread receipts and creation                    | the rest of `handler.ts`; `create-thread.ts`; `creation-admissions.ts`; `creation-validation.ts`; `EngineModels`' synchronous calls (`models.ts:37`–`:105`); `reclaimIdleSlot`'s choice (`slot-reclaim.ts:24`–`:48`); the three ports                                                                                     | `commands/{receipt,create,admissions,validation}.rs`; `models/select.rs` (E5.6), `release/reclaim.rs` (E5.6)                                                                              | E5.3, 4d     | `handler` (every command), `spawn`, `admitCreation`, `creationPending`, `cancelDelegatedInputs` | create, send, Stop, refusals and creation parity; the receipt bench                | 1,950      |
| **4f** the sends worker                                | `Engine.work`, `wake`, `wakeQueued`, `releaseDormant` (`index.ts:1220`–`:1384`); `readyForInput`, `threadCapabilities` (`message-facts.ts:42`–`:87`); the worker's synchronous steering reads (`steer-lane.ts:32`–`:45`, `:106`–`:140`; `steer-yield.ts`'s pure rules); `switchReady`, `usageBlocked`, `runsProviderWork` | `queue/{worker,ready}.rs`; `steering/route.rs` (E5.5), `transitions/switch_ready.rs` (E5.9)                                                                                               | E5.2, 4e     | none (the sends lane's `run`, E5.1 step 11)                                                     | a held send never reaches delivery; a runnable one reaches E5.5's stub once        | 900        |

Every round adds its binding methods in its own `#[napi] impl NativeEngine` block in
`ace-daemon-node/src/engine/{intents,queue,inputs,commands}.rs` (E5.1 step 9), fills the matching
functions in `apps/daemon/src/native-engine/{intents,queue,inputs,commands}.ts`, and puts its
`engine-probe` hooks in `ace-daemon-node/src/engine/probe_commands.rs`. A round that would pass
2,000 lines splits along its module list, never by arbitrary cuts, and no file passes 400 lines.
A ported function in an owner's file starts its file with
`//! Ported by E5.4<x> as a synchronous receipt dependency; owned by E5.<n>.`

## Amendments to E5.1

E5.1 is in review. These are its contract, written here for its builder to add before it merges.
If E5.1 merges first, 4a (the probe hook) and 4e (the ports) add them in one commit each, with an
E5.1 reviewer.

### Three synchronous ports (`ports.rs`, binding `engine/ports.rs`, shell `native-engine/ports.ts`)

Each is a synchronous JS callback on the JS thread, called with no `with_state` borrow held. It
runs inside the receipt's open transaction when the receipt calls it, so any store read sees the
receipt's uncommitted writes, and any store write nests as a savepoint on the **shared stack**
(E5.1 step 8) and rolls back with the receipt. Arguments and results cross as JSON through
`ace-json`. A throw crosses as a JS error and is handled as the TypeScript call site handles it.

| Port                                                   | Shell implementation                                                                                                                                                                                                                                                                                      | Rust call site                                                                                                                    | A throw                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `workspaceDirectory(path: string): string`             | `workspaceDirectory` (`workspace-directory.ts:3`–`:6`): `realpathSync`, then `statSync(...).isDirectory()`. The result is `realpathSync`'s string, unchanged.                                                                                                                                             | `validateCreation`'s `directory(path)` (`creation-validation.ts:41`), in `admitCreation` (no transaction open) and in the receipt | `workspace_unavailable`, as the `catch` at `:42`–`:44` |
| `portableHandoff(sourceThreadId): PortableContext`     | `creation-validation.ts:84`–`:104`'s body: `getThread`, `readBoundedItemPage(id, MAX_SAFE_INTEGER, 100, 262144)`, `historicalItemCount`, `portableContext(...)` with `{maxBytes: 65536, maxItems: 100, historyTruncated}`. Returns `portableContext`'s result as JSON, or `null` when the source is gone. | the `handoffFrom` branch, after the Rust checks before it; `null` → `handoff_source_not_found`                                    | propagates, as today (no `catch`)                      |
| `linkCreatedThread({threadId, at, prStatus?, issue?})` | `handler.ts:327`–`:342`'s store writes: `WorkspacePrLinks` `link`, `update` and `publish` when `prStatus` is given; `WorkspaceIssueLinks.link` when `issue` is.                                                                                                                                           | the receipt's create, at `:326`; the `transitions` context update (`:333`–`:337`) stays in Rust after it                          | propagates, as today                                   |

The shell's port object has a fixed shape. A test that passes no ports gets the shell's defaults,
which are these three implementations, because the TypeScript engine always uses them
(`index.ts:404`).

### One probe hook (`testing.ts`, binding `engine/probe_commands.rs`, feature `engine-probe`)

```ts
interface EngineProbe {
  // …E5.1's members…
  /** Calls one E5.3 `InputFacts` method natively, inside a transaction of its own; JSON in, JSON out. */
  inputFacts(method: string, args: unknown): unknown;
}
```

It reaches the fold hooks of 4a and 4b before E5.2 and E5.3 can drive them from a frame. Until 4a
lands it rejects with `NativeEngineIncomplete("inputFacts lands in E5.4a")`. It is scaffolding
and is deleted with E5.3's pass-through collaborators, when the last owner lands.

### The creation owner (E5.1 step 9's facade, `native-engine/commands.ts`)

`CommandContext.creationOwner` is a JS object compared by identity (`creation-admissions.ts:46`),
and the TypeScript tells three cases apart. `authorized` accepts an absent owner only when no
reservation holds the id, and refuses an object it doesn't know in every case: with a reservation
the identity differs, and without one `owner === undefined` is false. The facade keeps a
`WeakMap<object, number>` filled by `admitCreation`, and passes Rust one of three values:
`Owner::Absent` (no `creationOwner`), `Owner::Known(id)`, or `Owner::Unknown` (an object the map
lacks, including one whose reservation was released). Rust's `authorized` is then
`held ? owner == Known(held.owner) && held.command == command : owner == Absent`. `Unknown`
never equals anything.

## Module map

"Moves" means the owner's row in the guide drops the function; "stub" means a declaration in the
owner's file that fails `NotPorted`.

### 4a

| TypeScript                                                                                                                                                                           | Rust                                                                  | Notes                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intents.ts:9`–`:50`                                                                                                                                                                 | `intents/header.rs`                                                   | `IntentHeader` with the same fields. `status` and `delivery` decode strictly, as zod does, and a row this build can't read goes to `headers`'s `unreadable` callback.                                                                                                                    |
| `intents.ts:74`–`:456`                                                                                                                                                               | `intents/store.rs`                                                    | Same SQL, character for character, as statements cached per text on the shared connection. `headers` and `uncertainSends` page by 64 on `id`. The constructor's indexes stay TypeScript (decision 8).                                                                                    |
| `queue-store.ts:19`–`:50`                                                                                                                                                            | `queue/record.rs`                                                     | `RecoveryRecord`: `continuation` at most 16,384 UTF-16 units (zod's `max` counts code units).                                                                                                                                                                                            |
| `queue-store.ts:104`–`:240`, `:307`–`:459` (as the main fix leaves them)                                                                                                             | `queue/store.rs`                                                      | Readers follow "Queue reads before the `queue-rows` fill" (below), so `get` no longer throws `Missing queue metadata` for a missing row. `set` bumps `revision`, clears `lastFailure` exactly where `:146`–`:150` does, and appends `[...wakeFor, queue.updated]` in one `appendEvents`. |
| `queue-store.ts:242`–`:306`                                                                                                                                                          | `queue/page.rs`                                                       | Reads `engine_steer_notes.fell_back` (`:255`), which is why the steer notes are 4a's. `page`'s budget is the UTF-8 bytes of the stored payload text, cut at 512 KiB after the first message.                                                                                             |
| `steer-notes.ts:31`–`:50`                                                                                                                                                            | `steering/notes.rs` (moves from E5.5)                                 | `personSteered`, `fellBack`, `steeredAgain`, `personChose`. The table's DDL stays TypeScript.                                                                                                                                                                                            |
| `stale-inputs.ts`                                                                                                                                                                    | `queue/stale.rs`                                                      | `retireUncertainInputs` takes the thread's backend as an argument (4d reads it from session metadata), so 4a needs no `Repo`. `retire` throws `Invalid intent identity`.                                                                                                                 |
| `snooze-wake.ts:6`; `@ace/projection` `queueWakesSnooze` (`thread-attention.ts:42`), `snoozeWokeByQueue` (`snooze-woke.ts:59`)                                                       | `queue/wake.rs` (moves from E5.10); `ace-projection/src/attention.rs` | Only the queue branch of `threadAttention`.                                                                                                                                                                                                                                              |
| `input-fate.ts`; `input-delivery.ts`; `goal-change.ts`; `edited-context.ts`                                                                                                          | `inputs/fate.rs`, `rules.rs`                                          | Pure. `isDeepStrictEqual` is structural equality of the decoded JSON. `editedContext` compares `JSON.stringify` of both contexts, so key order counts.                                                                                                                                   |
| `repository.ts:485`–`:495` (`cancelled`), `:508`–`:515` (`add`), `:586`–`:660` (`engineQueueFact`, `latestIntent`, `commandsSince`, `queuedCount`, `inputCapacity`), `:664` (`mark`) | `intents/store.rs`, `queue/store.rs`                                  | E5.4's (E5.3 brief, module map). `engineQueueFact` takes the `ThreadState`. `add` passes `interactions.owner` (E5.7), which only interaction answers reach: a stub.                                                                                                                      |
| `packages/provider-kit/src/ipc.ts:4`                                                                                                                                                 | `ace-json/src/bounded.rs`                                             | Promote `ace-adapter-cursor/src/translate/tool_names.rs:14` and re-point its caller. It fails when the UTF-8 bytes pass the budget, when nodes (values plus own keys, in visit order) pass 32,768, when depth passes 64, or when an array is longer than `32768 - nodes`. One copy.      |
| `index.ts:591`–`:597`, `:1076`–`:1084`, `:1146`–`:1148`                                                                                                                              | binding `engine/{queue,intents}.rs`                                   | R and M, as in E5.1's table.                                                                                                                                                                                                                                                             |

`InputFacts` methods 4a implements: `pending.handedOver`, `pending.uncertainContinuation`,
`pending.resolvingInteractions`, `pending.finishContinuation`, `pending.awaiting`, `queue.get`,
`queue.set`, `queue.prune`, `queue.hasUncertain`, `retireEndedTurnInputs`, `goalChange`.

**Queue reads before the `queue-rows` fill** (E5.3 brief, "Queue reads"). The main fix's fill
inserts the missing `engine_queue` rows from `thread_state` by `rowid`, 256 a step, durable, with
a done signal. Until it is done, a thread may have no row, and 4a ports the readers exactly as the
main fix leaves them:

- **Only the settings default.** A missing row reads as revision 0, not paused, not limited, no
  continuation, no trigger, hold token 0, not exited.
- **Pending work is never defaulted.** `get` returns those defaults with `pendingCount` from
  `count(id)`. `snapshot` and `page` run their `intents` queries (`queue-store.ts:255`) whether or
  not the row exists, and take only `revision`, `paused`, `reason`, `resumeAt` and the exit from the
  defaults.
- **Writers `ensure` first.** Every `UPDATE engine_queue` site calls `ensure` (`:104`), as the main
  fix adds it.
- **`runnableThreads`** (`intents.ts:299`) uses `LEFT JOIN engine_queue` with
  `COALESCE(q.paused,0)=0` (and the same for `limited`), so a thread with pending intents and no
  row still runs.
- **Attachment retention.** Until `fills.complete("queue-attachments")`, `retains` for a thread
  also checks that thread's live intents' payloads for the hash, bounded by its live intents, so no
  attachment a live intent needs reads as unretained.

The statement text is the main fix's, copied character for character once it merges. If
`ace/fix-bounded-open-fills` changes any of this before it merges, the merged code wins and 4a
updates this section.

### 4b

| TypeScript                                                                                                       | Rust                              | Notes                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input-journal.ts:23`–`:41`                                                                                      | `inputs/origin.rs`                | `trigger` `user`, `unknown` or none → `person`; `goal` → `parent_agent`; anything else is its own kind. An explicit `origin` wins and gets `commandId`.                                                                                             |
| `input-journal.ts:42`–`:66`                                                                                      | `inputs/signature.rs`             | SHA-256 (`sha2` 0.11, as `ace-adapter-api` uses it) of the text parts of `withoutPortableHandoff(parts)` joined by `"\n"`, lowercase hex.                                                                                                           |
| `input-journal.ts:106`–`:294`                                                                                    | `inputs/journal.rs`               | `identify` throws `Provider reused an input message identity for a different command`. `generation IS ?` binds NULL for an absent generation, so `IS` stays.                                                                                        |
| `transcript-inputs.ts:157`–`:226` (`bindStartedRun`, `bindConsumedInput`, `bindItemRun`)                         | `inputs/runs.rs`                  | Pure over the `ThreadState` they are given and the journal. They mutate the state's item map before returning the event, as today.                                                                                                                  |
| `ace-input-attribution.ts`; `ace-inputs.ts:27`–`:41` (`get`, `attribute`)                                        | `inputs/ace.rs`                   | `AceInput.results` at most 64.                                                                                                                                                                                                                      |
| `ace-waits.ts`; `packages/mcp-server/src/waits.ts:15`                                                            | `inputs/ace_waits.rs`             | `WaitArguments` and `DelegateArguments` decoded exactly as their zod schemas, `bareToolName` included; targets de-duplicated in first-seen order.                                                                                                   |
| `packages/projection/src/portable-input.ts:5`; `packages/handoff/src/envelope.ts:25`                             | `inputs/signature.rs`             | `withoutHandoffEnvelope` measures and slices in **UTF-16 code units**, validates the manifest with `ace-protocol`'s `PortableHandoff`, and strips leading `\r?\n` runs.                                                                             |
| `packages/commands/src/native-command-inputs.ts:3`                                                               | `inputs/signature.rs`             | Throws `Unresolved command mention`.                                                                                                                                                                                                                |
| `packages/adapter-claude/src/input.ts:30`–`:99` (`content`, `admissions`: the text parts of the first admission) | `ace-adapter-claude/src/input.rs` | The errors fire in the same order with the same bytes: `Unresolved Claude mention`, `Claude image inputs require a matching base64 data URL`. File and PDF parts render as `content` renders them, and only their text survives into the signature. |
| `packages/adapter-pi/src/input.ts:4`–`:28` (`.message`)                                                          | `ace-adapter-pi/src/input.rs`     | 1 MiB per value and `+256` per part; `Unresolved Pi mention`, `Pi input exceeds frame budget`, `Pi images require a matching base64 data URL`, `Reserved Pi control command`.                                                                       |

`InputFacts` methods 4b implements: `inputs.correlate`, `inputs.keyFor`, `aceInputs.attribute`,
`aceWaitFact`, `bindConsumedInput`, `bindStartedRun`.

### 4c

| TypeScript                                                                                                                                                 | Rust                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript-inputs.ts:14`–`:156`, `:227`–`:254`                                                                                                            | `inputs/transcript.rs`                            | `notifyNamingPrompt` defers the `onNamingPrompt` port call to after commit ("Receipt effects").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ace-inputs.ts:20`–`:24` (`record`)                                                                                                                        | `inputs/ace.rs`                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `title-input.ts:17`–`:27`                                                                                                                                  | `inputs/title.rs`                                 | `oldestTitleInput` walks the index one item at a time through `Repo`'s `read_item_page`. The index DDL stays TypeScript.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `thread-posts.ts`                                                                                                                                          | `inputs/posts.rs`                                 | Reached as `engine.hosts.posts` (`host-threads.ts:42`, `services/thread-address.ts:60`). E5.7's `hosts` facade object exposes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/ui-core/src/thread-title.ts:14`, `:53`; `composer-markers.ts` (`attachmentMarker`)                                                               | `inputs/provisional_title.rs`                     | First line with words, no Markdown, mentions, chips or markers, single spaces, at most 60 characters, cut at a word boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session-metadata.ts` (`session`, `backend`, `createSession`, `createUnpreparedSession`)                                                                   | `sessions/metadata.rs` (moves from E5.6)          | Row reads and writes only. `nativeSession` and `pinSessionIdentity` stay E5.6's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `transition-state.ts:87`–`:196` (`guarded`, `guardOwner`, `guard`, `get`, `set`, `remember`), `history.grant`                                              | `transitions/state.rs` (moves from E5.9)          | Metadata rows. `releaseGuards` (`:102`) is 4d's. `delivered` and `selection` stay E5.9's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `transition-readiness.ts:85`–`:95` (`refreshBlocked`, `agentsReady`, `acceptsPersonInput`); `repository.ts:496`–`:507` (`quiescent`, `acceptsPersonInput`) | `transitions/readiness.rs` (reads move from E5.9) | `capture` stays E5.9's, through E5.3's `MoveFacts`. Both answering methods check `fills.rebuilt(thread)` first and answer false until the thread's `readiness` rebuild has committed (E5.3 brief, "Readiness"). The asynchronous paths that await `when_rebuilt` there (`steer-lane.ts:119`, transitions) are E5.5's and E5.9's. `admitSteer` runs in the synchronous receipt, so it reads the plain answer: a thread not yet rebuilt is not quiescent, and its selecting steer splits into a queued switch, the busy-thread outcome. `quiescent` and `acceptsPersonInput` from `@ace/core` go to `ace-core` (`person_input.rs`), with `continueMessage`. |
| `permissions.ts:115`–`:124` (`ensure`, with `state` and `read`)                                                                                            | `access/storage.rs` (moves from E5.7)             | `INSERT OR IGNORE`, then the read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `index.ts:1135`–`:1145` (`inputFate`)                                                                                                                      | binding `engine/inputs.rs`                        | One transaction, as today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 4d

| TypeScript                                                                                                                                             | Rust                                                                              | Notes                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handler.ts:55`–`:123`                                                                                                                                 | `commands/prelude.rs`                                                             | Check order is contract (below). `adoptImportedThread` (E5.8) is a stub. `providerCommandDisabled` goes to `ace-core` (`provider_admission.rs`).                                                                                                                                                                                        |
| `recovery.ts:111`–`:129` → `queue-commands.ts:17`–`:262`                                                                                               | `queue/commands.rs`                                                               | Every branch. `RestartStreaks.clear` (`restart-resume.ts:98`–`:100`, one `DELETE`) moves with it.                                                                                                                                                                                                                                       |
| `recovery.ts:91`–`:110`, `:130`–`:200`, `:618`–`:627`, `:717`–`:739`, `:780`–`:840`                                                                    | `queue/holds.rs` (moves from E5.8)                                                | `schedule` cancels the previous timer and arms the next deadline. Inside a transaction it runs at commit ("Receipt effects"). The timer's callback is `recovery::fire` (E5.8), a stub that reports `NotPorted` through `onError` once per firing and never throws. `RecoveryPreferences` decodes with its defaults (`queue`, `manual`). |
| `guest-admission.ts`                                                                                                                                   | `commands/guest.rs`                                                               | The (b) cases of `retired-bot-threads.test.ts` move here.                                                                                                                                                                                                                                                                               |
| `steer-selection.ts:20`–`:106`                                                                                                                         | `steering/selection.rs` (moves from E5.5)                                         | `fenceSteer`, `steerLostRun` (with `runId: null` meaning the sender saw no run), `admitSteer`, `queueSteerSelection`.                                                                                                                                                                                                                   |
| `switch-admission.ts:48`–`:112` (`resolveSwitch`, `recordSwitch`)                                                                                      | `transitions/switch_admission.rs` (moves from E5.9)                               | The receipt side of a selecting steer. Executing the switch stays E5.9's.                                                                                                                                                                                                                                                               |
| `stop-intents.ts:5`–`:106` (`cancelPending`, `cancelDelegatedInputs`); `stop-scope.ts:10` (`targetsRoot`); `transition-state.ts:102` (`releaseGuards`) | `liveness/{stop_intents,stop_scope}.rs` (move from E5.10), `transitions/state.rs` | Guard release for a Stop is ported; the merge or fork it released runs in E5.9.                                                                                                                                                                                                                                                         |
| `index.ts:1111`–`:1134`, `:1150`–`:1153`                                                                                                               | binding `engine/commands.rs`                                                      | `silence.prepareCommand` returns at once without a `resolveSilenceMs` port (`silence.ts:85`); with one it is E5.6's stub.                                                                                                                                                                                                               |
| `index.ts:410`–`:431`                                                                                                                                  | shell, as E5.1 step 9                                                             | With 4d alone, every payload type outside the prelude and the queue commands throws `NotPorted("thread commands land in E5.4e")`.                                                                                                                                                                                                       |

### 4e

| TypeScript                                                                                                            | Rust                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handler.ts:124`–`:204`, `:376`–`:556`, `:562`–`:591`                                                                 | `commands/receipt.rs`                       | `acceptTransition`: stub for `thread.fork`, `thread.merge`, `thread.switch`; every other type passes (`transition-handler.ts:29`). Permission and mode set, and `interaction.resolve`: stubs (E5.7).                                                                                                                                                                                                                                                                                                                                                |
| `handler.ts:205`–`:375`; `create-thread.ts`                                                                           | `commands/create.rs`                        | `createThreadState` is `ace_core::state::create_thread_state`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `creation-admissions.ts`                                                                                              | `commands/admissions.rs`                    | The three-way owner ("Amendments to E5.1").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `creation-validation.ts`                                                                                              | `commands/validation.rs`                    | `reportedOrTable` (`access-modes.ts:127`) and `cursorInstanceId` (`cursor-selection.ts:5`) beside it, the paths read.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `models.ts:19`–`:105` (constructor, `permissionCapabilities`, `knownPermissionCapabilities`, `permissions`, `select`) | `models/select.rs` (moves from E5.6)        | **Always constructed, catalog or not** (`index.ts:193`; handed to the handler at `:408`). Without a catalog, `select` is `isDefaultSelection(model) ? undefined : model`. With one it calls the `models` port's `resolve` and `list` synchronously, as `:84`–`:104` and `:56`–`:58` do, with `selectionModelFilter` and `executionModelId` from `@ace/models` ported beside it. `onModelUnavailable` is called before `ModelSelectionError`, and that error maps to `model_unavailable`. `prepare` (async) and `migrateCachedDefaults` stay E5.6's. |
| `slot-reclaim.ts:24`–`:48`                                                                                            | `release/reclaim.rs` (moves from E5.6)      | The choice and the `idleDue` mark. The retire wake goes on the after-commit queue. Closing the session stays E5.6's.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/daemon/src/worktree-base.ts:13`–`:53`; `thread-fence.ts:102`                                                    | `commands/create.rs`, `commands/receipt.rs` | Pure; SQL with the same text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `index.ts:599`–`:646`, `:921`–`:926`, `:1092`–`:1110`                                                                 | binding `engine/commands.rs`                | `spawn` still throws `Spawn requires thread.create or thread.prepare`. `permissions.narrow` and `parent` (E5.7, the ceiling) are stubs reached only with `parentThreadId`.                                                                                                                                                                                                                                                                                                                                                                          |

### 4f

| TypeScript                                                                                                                                                 | Rust                                            | Notes                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts:1300`–`:1384` (`work`)                                                                                                                           | `queue/worker.rs`                               | After `actor.flush()` every check is re-read. `delivery.run` and `delivery.fail` (E5.5) and `sessions.close` (E5.6) are stubs: execution.                                                                                                         |
| `index.ts:1220`–`:1277`                                                                                                                                    | `queue/worker.rs`                               | `wake` checks `isHistoryWriting` and defers through `store.writable()`, as `:1260`–`:1271` does.                                                                                                                                                  |
| `message-facts.ts:42`–`:87`                                                                                                                                | `queue/ready.rs`                                |                                                                                                                                                                                                                                                   |
| `steer-lane.ts:32`–`:45` (`isSteer`, `yielded`), `:106`–`:140` (`route`); `steer-yield.ts`'s `isPersonSteer`, `steerRestartsTurn`, `rootRun`, `steerRoute` | `steering/route.rs` (moves from E5.5)           | `work` calls `yielded` (`index.ts:1363`) before it picks an ordinary message, so it must not be a stub. `route` clears a stale `steerYield` on the actor, as `:135`–`:136` does. `run`, `steerNow`, `yieldTurn` and `markYieldedEnd` stay E5.5's. |
| `switch-recovery.ts:6`–`:61` (`usageBlocked`, `switchReady`); `transition-history.ts:26` (`runsProviderWork`)                                              | `transitions/switch_ready.rs` (moves from E5.9) | Synchronous reads.                                                                                                                                                                                                                                |

## The receipt dependencies

What an ordinary receipt or the sends worker reaches synchronously, and what E5.4 does with each.
"Port" is decision 1; "stub" is an owner's own command or execution.

| Function                                                                                                     | Reached by                                                         | Owner       | E5.4                          | Round |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------- | ----------------------------- | ----- |
| `SteerNotes`                                                                                                 | queue reads; `queue.edit` to steer                                 | E5.5        | port                          | 4a    |
| `wakeFor`                                                                                                    | every `queue.set`                                                  | E5.10       | port                          | 4a    |
| session metadata rows                                                                                        | every create; every capability and backend read                    | E5.6        | port                          | 4c    |
| transition metadata and guards; handoff grant                                                                | every create and send; `admitSteer`                                | E5.9        | port                          | 4c    |
| readiness reads, `quiescent`, `acceptsPersonInput`                                                           | `admitSteer`; `readyForInput`                                      | E5.9        | port                          | 4c    |
| `permissions.ensure`                                                                                         | every create                                                       | E5.7        | port                          | 4c    |
| `fenceSteer`, `admitSteer`, `queueSteerSelection`, `steerLostRun`                                            | every send; `queue.edit`                                           | E5.5        | port                          | 4d    |
| `resolveSwitch`, `recordSwitch`                                                                              | a steer that changes model or options                              | E5.9        | port                          | 4d    |
| `Recovery`'s command path; `RestartStreaks.clear`                                                            | every queue command and send                                       | E5.8        | port                          | 4d    |
| `cancelPending`, `cancelDelegatedInputs`, `targetsRoot`, `releaseGuards`                                     | every Stop; delegation cancel                                      | E5.10, E5.9 | port                          | 4d    |
| `EngineModels` synchronous calls                                                                             | every create; `validateCreation`                                   | E5.6        | port                          | 4e    |
| `reclaimIdleSlot`'s choice                                                                                   | a receipt at capacity                                              | E5.6        | port                          | 4e    |
| `yielded`, `route`, `isSteer`, steer-yield's pure rules; `switchReady`, `runsProviderWork`                   | every pass of the sends worker                                     | E5.5, E5.9  | port                          | 4f    |
| `Recovery.fire`, `automatic`                                                                                 | a deadline's timer                                                 | E5.8        | stub (reported, never thrown) | 4d    |
| `acceptTransition`                                                                                           | `thread.fork`, `thread.merge`, `thread.switch`                     | E5.9        | stub                          | 4e    |
| `permissions.accept`, `acceptNative`, `narrow`, `parent`; `interactions.outcome`, `owner`; `validResolution` | permission or mode set; spawn with a parent; `interaction.resolve` | E5.7        | stub                          | 4e    |
| `adoptImportedThread`                                                                                        | a send to an imported thread                                       | E5.8        | stub                          | 4d    |
| `threadTree`                                                                                                 | archive with `beforeSeq`                                           | E5.10       | stub                          | 4e    |
| `delivery.run`, `delivery.fail`, `sessions.close`, `models.prepare`                                          | the sends worker; session opening                                  | E5.5, E5.6  | stub                          | 4f    |

A stub reached inside a receipt throws, so the shell's `store.atomic` rolls the receipt back and
the caller gets the JS error. It is never a `CommandResult`. The switch is off by default until
E5.10, so no person sees one.

## The receipt, rule by rule

`engineHandler.handle` (`handler.ts:55`–`:556`) checks in this order, and the first that applies
wins. Tests pin which refusal wins when two apply, so the order is contract.

1. **Guest, then host** (`:57`–`:64`), for any payload with a `threadId`.
2. **Imported thread** (`:65`–`:76`): a `thread.send` to an `imported` thread adopts it; if that
   throws, `history_unavailable`.
3. **Deleting** (`:77`–`:82`): `thread_deleting`.
4. **Retired Cursor CLI thread** (`:83`–`:95`): any type but `thread.archive` and `thread.fork`.
5. **Provider disabled** (`:97`–`:118`), only with a `providerEnabled` port.
6. **Workspace reserved** (`:119`–`:121`).
7. **Queue commands** (`:122`–`:123`) → `handleQueue`.
8. **Transitions** (`:124`–`:134`).
9. **Permission and mode** (`:136`–`:153`).
10. **Workspace change preparing or uncertain** (`:154`–`:163`).
11. **Size** (`:164`–`:170`), for `thread.send` and `thread.create`: more than 64 parts, or
    `boundedJson(command, 262144)` failing.
12. **Type list** (`:191`–`:204`): else `not_implemented`.
13. **One `store.atomic`** (`:205`): create and prepare (`:206`–`:375`), or the thread checks
    (`:376`–`:445`), or the interaction and task targets (`:446`–`:478`); then the admission tail
    (`:480`–`:553`).

The admission tail, in order:

- Cursor SDK sends: `provider_input_budget_exceeded`, then `provider_input_queue_full`
  (`:480`–`:487`).
- `recovery.admit` (`:489`; `recovery.ts:130`–`:150`): it **clears the restart streak first**
  (`:133`), then refuses with `queue_capacity_exceeded` at 256 inputs in flight or over 256 KiB as
  `Buffer.byteLength(JSON.stringify(command))`, then drops a restated selection and fills an
  omitted delivery from `followUpBehavior`.
- `fenceSteer`, then `admitSteer` (`:492`–`:494`).
- For `thread.send`: `retireUncertainInputs`, `releaseInterruptedHold`, `releaseLimitHold`
  (`:500`–`:504`).
- Reserve a slot unless the send is held: `engine_capacity_exceeded` (`:505`–`:506`).
- A thread Stop (`:510`–`:535`): `cancelPending`, then hold the queue `stopped` (`limited: false`,
  `resetAt`, `resumeAt` and `timerAction` cleared, `holdToken + 1`), then `limit.cleared` for each
  limited agent without `externalStatus`.
- `repo.add`, `acceptInput`, `queueSteerSelection`; for create and send, `notifyNamingPrompt`, an
  empty `queue.set` (a revision bump with its `queue.updated`), `recovery.sync` (`:536`–`:543`).
- Wakes for the thread, then each released thread (`:545`–`:548`).
- `{commandId, ok: true, threadId}`.

### What a refusal commits

A refusal is a `CommandResult`, not a throw, so the transaction around it **commits**. Writes the
receipt made before refusing stay. The Rust returns `Ok(result)` and commits the same way. Known
writes before a refusal:

- `queue_capacity_exceeded`: the restart streak is already cleared (`recovery.ts:133`).
- `engine_capacity_exceeded` on a send: uncertain inputs are retired, a stopped or restart hold
  and a limit hold are released, each with its `queue.updated` (`handler.ts:500`–`:506`).
- `history_unavailable` comes after a failed adoption; any successful adoption followed by a later
  refusal stays adopted (`:65`–`:76`).
- In a queue command, refusals come before its writes, except a resend of a continuation, which
  checks capacity before any write.
- `reserve` in a create (`:263`) is the last check before writes.

Refusals before step 13 and the prelude's refusals write nothing. Only a throw (a stub, a store
error, a policy throwing after `accept`) rolls back.

### Receipt effects are commit-scoped

Every receipt read and write goes through the `Tx` of the shell's open transaction: the outer
stack, with the TypeScript's inner `store.atomic` calls as nested savepoints, and no statement
outside it. No Rust cache holds queue, intent or journal state (prepared statements only). Every
effect outside the database goes on the outermost transaction's after-commit queue (E5.1 step 3),
is dropped on rollback, and runs once, after the shell's publication:

| Effect                                              | TypeScript today                                                                                                                             | Native                                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| thread and released-thread wakes                    | `queueMicrotask` (`handler.ts:545`, `queue-commands.ts`, `recovery.ts:816`)                                                                  | after-commit wake                                                                                                                                        |
| `schedule`: cancel the deadline timer, arm the next | immediately, inside the receipt (`recovery.ts:618`–`:627`)                                                                                   | after commit, reading `nextDeadline` then; outside any transaction, at once                                                                              |
| `onNamingPrompt` (title and branch generation)      | inside the receipt; `ThreadTitles.namingPrompt` marks `attempted` at once and starts its work by microtask (`../thread-titles.ts:97`–`:118`) | the port is called at the outermost commit, so a rolled-back receipt never names its thread or burns its one attempt; main matches after its fix (below) |
| the reclaim's retire wake                           | `ports.retire` inside the receipt (`slot-reclaim.ts:44`)                                                                                     | after-commit wake                                                                                                                                        |

On rollback, in-memory marks the receipt made are undone the way E5.3's rollback undoes resident
state (E5.3 step 8). The reclaim's `idleDue` and the repository's `retiring` set are E5.3's and
E5.2's, so 4e asks those reviews to confirm.

TypeScript names a thread whose receipt rolled back, which is a bug on main. It is fixed there
first ("Main fixes E5.4 depends on"), so both backends behave the same.

### Error texts, byte-exact

A `CommandResult` crosses as JSON, so key order is the order shown here, and absent fields stay
absent (never `null`). Refusals are `{commandId, ok, error}`, plus `code`, `title` and `detail`
in that order where shown.

| Error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Extra fields                                                                                                                                | Source                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `guest_thread`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `title: "No agent here"`, `detail: "This thread holds work from ${guest.name \|\| "another machine"}; it has no agent here."`               | `guest-admission.ts:26`–`:32`  |
| `host_thread` (Spade's host thread)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `title: "Spade's own thread"`, `detail: "Spade works through this thread; nothing runs in it."`                                             | `guest-admission.ts:49`–`:55`  |
| `host_thread` (`spade-bot`, every command)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `title: "A Spade bot's old thread"`, `detail: "Spade bots no longer run here; talk to the bot in Spade."`                                   | `guest-admission.ts:61`–`:67`  |
| `cursor_cli_retired`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `title: "This Cursor thread is read-only"`, `detail: "Continue in a new thread to carry its history to Cursor."`                            | `handler.ts:89`–`:94`          |
| `interaction_expired`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `code: "interaction_expired"`, `title: "Question expired"`, `detail: "The provider disconnected. This question can no longer be answered."` | `handler.ts:171`–`:189`        |
| `interaction_unavailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `code: "interaction_unavailable"`, `title: "Question unavailable"`, `detail: "This question is no longer active."`                          | same                           |
| `history_unavailable`, `thread_deleting`, `provider_disabled`, `workspace_change_in_progress`, `thread_not_found`, `not_implemented`, `message_too_large`, `thread_creation_in_progress`, `model_unavailable`, `workspace_preparation_mismatch`, `engine_capacity_exceeded`, `thread_changed`, `thread_transition_in_progress`, `unsupported_goal`, `agent_not_found`, `stale_interrupt`, `unsupported_child_control`, `already_resolved`, `invalid_resolution`, `task_not_found`, `task_not_stoppable`, `provider_input_budget_exceeded`, `provider_input_queue_full`, `queue_capacity_exceeded` | none                                                                                                                                        | `handler.ts`                   |
| `invalid_command`, `pr_requires_worktree`, `thread_exists`, `message_too_large`, `acp_identity_required`, `provider_unavailable`, `workspace_not_found`, `workspace_unavailable`, `workspace_change_in_progress`, `conflicting_account_selection`, `permission_mode_unsupported`, `handoff_source_not_found`, `queue_capacity_exceeded`, `provider_input_budget_exceeded`, `launch_options_unsupported`                                                                                                                                                                                           | none, in `validateCreation`'s order (`creation-validation.ts:23`–`:128`)                                                                    | `creation-validation.ts`       |
| `invalid_queue_command`, `thread_not_found`, `queue_conflict`, `message_already_claimed`, `uncertain_delivery`, `message_too_large`, `invalid_queue_entry`, `message_not_uncertain`, `engine_capacity_exceeded`, `invalid_queue_position`, `sdk_account_migration_unsupported`, `acp_account_fixed`, `migration_unavailable`, `no_scheduled_resume`, `switch_selection_required`, `reset_time_unknown`, `recovery_in_progress`                                                                                                                                                                    | none                                                                                                                                        | `queue-commands.ts`            |
| `thread_exists`, `permission_parent_not_found`, an `AccessError` code or `permission_ceiling_unverifiable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | none                                                                                                                                        | `spawn`, `index.ts:621`–`:640` |

Successes are `{commandId, ok: true, threadId}` for create, prepare, send and the thread commands,
and `{commandId, ok: true}` for archive and every queue command.

Not `CommandResult`s, and byte-exact too:

- `admitCreation` returns strings: `daemon_shutting_down`, `engine_starting`, then
  `validateCreation`'s error, then `acquire`'s `invalid_command`, `thread_creation_in_progress`,
  `thread_exists`, `engine_capacity_exceeded`.
- `queuePage` **throws** plain `Error`s, `queue_conflict`, `queue_revision_required` and
  `invalid_queue_cursor`, checked in that order (`queue-store.ts:269`–`:279`). Callers match the
  message (`services/recovery.ts:148`).
- Stored intent errors: `Cancelled before delivery`, `Cancelled by queue pause`,
  `Removed from queue`. `commandFailure` falls back to `Not delivered` and `inputFate` to
  `Not sent`.
- Thrown inside the engine: `Missing queue metadata`, `Invalid queue entry`,
  `Invalid intent identity`, `Provider reused an input message identity for a different command`,
  and 4b's input-text errors.

### Commands as stored

`intents.payload` is `JSON.stringify(command)`. Where the TypeScript ran `Command.parse` first,
zod strips unknown keys, applies defaults and orders keys by the schema (rule 8). Those sites are
`recovery.admit`, `withoutRestatedSelection`, `fenceSteer`, `admitSteer`, `queue.edit`, the
`queue.resend` replacement, `acquire`'s normalized command, `spawn`, and `personCommand` in the
shell. Where it did not (a `thread.create` that `validateCreation` returns unchanged), the stored
text is the command as it arrived. The Rust decodes with `ace-protocol`'s `Command` and serializes
in schema order exactly at those sites, and passes the arrived `ace_json::Value` through
elsewhere. Byte length is observable: `queuePage`'s 512 KiB budget and the admission budgets
measure it.

## Creation

- **Two phases.** `admitCreation` (`index.ts:1095`) validates, then `acquire` reserves a slot and
  holds the id across the server's Git preparation. The receipt accepts the same owner with the
  same command (`JSON.stringify` equality), or no owner when nothing holds the id. An unknown
  owner is refused ("Amendments to E5.1").
- **Validation** (`creation-validation.ts:14`–`:129`) runs in both phases, in its order, with the
  catalog-backed capabilities at `:62`: `models.permissionCapabilities(provider, instanceId,
base)`, which reads the catalog's `list` when a catalog is configured.
- **The receipt's create** (`handler.ts:206`–`:375`), in order: `authorized`; validate; `select`
  (`:227`–`:237`, with the catalog); the pull-request and prepared-workspace checks; the slot
  (skipped for `thread.prepare`); `createEngineThread`; `linkCreatedThread`; the PR workspace
  context; the handoff context and its synthetic `handoff:<commandId>` input; the history grant.
  A prepare releases its slot and returns at `:370`.
- **`createEngineThread`** writes, in order: `permissions.ensure`, the parsed `Thread` (with a
  second `ensure` inside it, as today), `hasSentMessage = false`, `save(state, [thread.created])`,
  the session row, `queue.ensure`, `transitions.set`, `transitions.remember`.
- **Title**: `p.title`, else `provisionalTitle(p.input)` for create, else `New thread`. The source
  is `agent` for a prepare that says so, `person` for any explicit title, else `provisional`.

## Queue semantics

- **Queued and steered.** `delivery: "queue"` waits for the root's run to end; `"steer"` joins the
  running turn, or starts the next turn when none runs (ADR 0053, 2026-10-17 and -18). An omitted
  delivery on `thread.send` becomes `followUpBehavior` (default `queue`) at admission. Other
  intents store `queue`.
- **Fencing a steer** (`fenceSteer`, `steer-selection.ts:20`–`:30`). Only a send with a `runId`
  is fenced. `runId: null` means the sender saw no run, so it is lost when a root run is active
  now. A string is lost unless that run is the active root run and still `active`. A lost steer is
  re-parsed without `runId`, and its delivery becomes `queue` only if the sender gave one: an
  omitted delivery stays omitted, so `followUpBehavior` decides it later.
- **Splitting a selecting steer** (`admitSteer`, `:50`–`:93`). A steer that names a model or
  options, on a provider that can steer, while the tree is not quiescent and a slot is reserved,
  becomes the plain send plus a `thread.switch` (`<commandId>:selection`). Its selection builds on
  a queued switch's selection, else the thread's transition selection, else the session. It is
  recorded and placed right after the send. Otherwise, including when `resolveSwitch` returns a
  string, the **fallback** is the same send with `delivery: "queue"`.
- **What counts.** `pendingCount` counts waiting sends and creates plus uncertain sends and
  continuations, never child results (`trigger = 'subagent_result'`), plus one for a live
  continuation that isn't uncertain. `waitingSends` includes child results. Snapshot, page,
  `head`, `editable` and `move` never show or touch a child result.
  `prioritizeSubagentResult` sets position 0 with no revision bump.
- **Capacity**: 256 inputs in flight (`inputCapacity`; an uncertain input does not count), 256
  KiB per command, 64 parts per message.
- **Revision**: every `queue.set` increments `revision` and appends `queue.updated`, with a snooze
  wake first when one applies, so an empty patch is a bump. Every queue command compares
  `expectedRevision` (`queue_conflict`). Claimed messages are immutable
  (`message_already_claimed`).
- **Holds**: `paused` with a reason of `stopped`, `restart`, `manual`, `limit`, `snooze`,
  `uncertain`, `not_sent` or `model_unavailable`. `limited`, `resetAt`, `resumeAt` and
  `timerAction` hold a limit and its deadline. `holdToken` increments on every hold change (`owns`,
  `begin`, `release`). `lastFailure` clears when a hold is released or replaced by a reason other
  than a failed send. `exited` follows `exitedAfter` and shows only when true. `shown` hides
  `resumeAt` for a `clear` deadline.
- **What releases a hold**:
  - A new `thread.send` releases a `stopped` or `restart` hold unless limited, uncertain,
    recovering or a Cursor SDK `restart` (`releaseInterruptedHold`). It also lifts a `limit` or
    `snooze` hold, or the `clear` marker, unless uncertain or recovering (`releaseLimitHold`). And
    it retires every uncertain input, keeping a Cursor SDK continuation.
  - Removing or editing the head of a `not_sent` or `model_unavailable` hold releases it, without
    a continuation or limit (`queue-commands.ts:37`–`:43`).
  - Resending the last uncertain input releases only an `uncertain` hold.
  - `queue.pause` fails pending resume intents with `Cancelled by queue pause` and holds `manual`.
  - `thread.resume`, `queue.resume` and `thread.limit` add a recovery intent and hold under the
    current reason, or `manual`. A reset-timed action takes the account's reset, else the stored
    one, and refuses one in the past. `cancel_resume` turns a scheduled resume into a `clear`.
- **Stop** (`cancelPending`, `stop-intents.ts:5`–`:66`). It does not cancel waiting sends.
  - Pending and queued **sends stay queued**, held by the `stopped` hold for the person's Resume or
    next message.
  - Pending resume and limit intents fail with `Cancelled before delivery`; their continuation
    record stays for a later Resume.
  - Pending merges fail and release their guards, and fork guards are released.
  - User inputs of active runs get `notAnswered: "stopped"`.
  - A running or awaiting send, create or fork **that was claimed but never submitted** (no
    `submittedGeneration`, not acknowledged) is **deferred**: it goes back to `queued`. One that
    **was submitted** fails with `Cancelled before delivery` and its item is marked `stopped`.
- **Persistence**: `engine_queue`, `intents`, `engine_queue_attachments` and `engine_steer_notes`,
  written in the receipt's transaction. A queued message is not in the transcript: its item is
  created when delivery claims it (`admitInput`, ADR 0065).
- **Stale inputs.** An uncertain input holds the queue (`uncertain`) until it is retired, and is
  never sent again.
  - `retireEndedTurnInputs` retires only the uncertain sends whose `submitted_generation` equals
    the generation of the session that ended a turn. Sends of other generations stay.
  - `retireUncertainInputs` (a new message) retires all of them, except a Cursor SDK
    continuation.
  - Only the `uncertain` hold lifts, and only when none is left. A limit or continuation
    reconciles its own reason, and any other case gets a revision bump.
- **Input fate**, in this order: replaced; uncertain; waiting (`pending` or `queued`); delivered
  with its run; failed (`removed` for `Removed from queue`, else the error or `Not sent`), checked
  before "written"; delivered (written); else by status: unknown, sending (`running`), delivered
  (`done`).

## Intents and their journal

- **`intents`** holds each accepted command with its kind, stored payload, status (`pending`,
  `queued`, `running`, `done`, `failed`), attempts, `awaiting`, `ack_target`, delivery,
  `acknowledged`, trigger, the submitted and resolution generations, `resolution_id`, position,
  `uncertain` and error. Its schema is TypeScript's (decision 8); its statements are 4a's.
- **Dispatch order** is `(position, id)` within a group. Recoveries come before deliveries;
  `transition` puts switch before merge; the person's steer goes ahead of ace's (`personSteer`).
  Controls are everything else that is `pending`, 64 at a time. `runnableThreads` excludes
  threads with a slot, a foreign transition guard or fenced ownership.
- **The sends worker's choice** (`work`, 4f), after `actor.flush()`:
  1. A poisoned actor fails its waiting intents with the two fixed messages (`index.ts:1306`–`:1311`).
  2. A reserved workspace or a fenced thread waits.
  3. A ready transition runs.
  4. Then a recovery.
  5. Nothing runs while a recovery acknowledgement is outstanding or the queue is held.
  6. Otherwise it picks: a child result when a transition heads the queue; else the yielded steer;
     else, when the head is a steer and a root run is active, the queued message; else the head.
     The pick is marked `queued`, the queue is synced, and it is delivered only when nothing is
     awaiting and `readyForInput` holds.
- **`readyForInput`**: a child result waits for the whole tree; a quiescent thread takes anything;
  a selecting send waits while provider work runs. Otherwise the derived status must be `new`,
  `done` or `failed`, or the send must be the person's or a parent agent's, with no selection,
  while the root accepts person input.
- **Lifecycle writes**: `add`, `claim`, `beginSend`, `submit`, `joinRunningTurn`, `defer`,
  `requeue`, `mark`. 4a ports them; E5.5 calls the delivery ones.
- **The input journal** correlates provider echoes with accepted inputs without scanning history.
  - `register` at acceptance keeps the signature of the person's parts and the origin.
  - `sending` at delivery re-signs with the provider's own rendering (Claude's first admission,
    Pi's message) and records the generation.
  - `correlate` matches a root user message by native identity, then by echo alias, then by the
    oldest unmatched sent input of that generation with the same signature. It rewrites the fact
    to the input's key, origin and `synthetic: !personInput(origin)`, and keeps the person's
    parts.
- **Runs**: `attachRun` binds a steer to its run. `bindSent` gives a generation's sent, unbound
  inputs to the run that started. `bindConsumedInput` moves a steer the provider reports consumed
  elsewhere, re-creating its item when it leaves a finished run.

## Ace-input attribution

Origin comes only from ace's persisted command, never from native content.
`AceInputs.record` keeps, per thread and command, the agent, the item key and up to 64 outcomes.

- **An echo is folded into its settled delegation.** A user-role echo with a `subagent_result`
  origin and a `commandId` becomes a `delegation.settled` item for the recorded agent and item:
  `complete: true`, the results, `delivery: "ace-input"`, `origin: "ace"`, and the echo's `raw`.
  An echo on another agent, or with no record, passes unchanged.
- **The child result shows once.** `admitInput` writes no user item for a child result that has
  a record, so it appears only as its settled delegation.
- **ace waits.** `aceWaitFact` marks a running ace `wait`, or a `delegate` with `waitSeconds`, as
  `subagents.waiting` on `ace-child:<threadId>` targets, once per item.

## Open-time work

Every statement E5.4's modules run when the store opens, its cost under ADR 0170 (`:40`–`:60`),
and who handles it. The DDL stays TypeScript (decision 8). The fills are the E5.3 brief's
("Prerequisite fix on main"), and E5.3 ports them. E5.4 owns only its readers' fallbacks.

| Statement (TypeScript)                                                                                                                                                                                                       | Cost                                                                           | After the main fix                                                                                                                                                                                                       | E5.4                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `CREATE TABLE IF NOT EXISTS` (`queue-store.ts:57`–`:68`, `input-journal.ts:71`–`:94`, `ace-inputs.ts:10`–`:15`, `steer-notes.ts:17`–`:19`)                                                                                   | O(1)                                                                           | stays at open                                                                                                                                                                                                            | nothing                                                                         |
| `CREATE INDEX IF NOT EXISTS` on `intents` (`intents.ts:60`–`:63`, `queue-store.ts:71`–`:74`), `engine_inputs` (`input-journal.ts:76`, `:96`–`:97`), `engine_queue` (`queue-store.ts:70`), `engine_queue_attachments` (`:69`) | O(1) where the index exists; history-sized the first time on a home without it | The main PR lists each index and the release that added it. One every supported home (schema 14 or newer) has stays at open. One a supported home can lack moves out of open (ADR 0170 §2) or is filed as its own issue. | nothing                                                                         |
| `CREATE INDEX engine_first_person_input ON items(...)` (`title-input.ts:12`)                                                                                                                                                 | the same, on `items`                                                           | the same                                                                                                                                                                                                                 | nothing                                                                         |
| `INSERT OR IGNORE INTO engine_queue(thread_id) SELECT thread_id FROM thread_state` (`queue-store.ts:75`)                                                                                                                     | history-sized, every open                                                      | fill `queue-rows` (durable)                                                                                                                                                                                              | 4a: "Queue reads before the `queue-rows` fill"                                  |
| `requireEngineColumns` (`queue-store.ts:76`, `input-journal.ts:95`); `exited` `ALTER TABLE ADD COLUMN` (`:77`–`:85`)                                                                                                         | O(1)                                                                           | stays at open                                                                                                                                                                                                            | nothing                                                                         |
| the attachment re-track of live intents (`queue-store.ts:86`–`:93`)                                                                                                                                                          | history-sized, every open (no index covers its predicate)                      | fill `queue-attachments` (durable)                                                                                                                                                                                       | 4a: the `retains` fallback                                                      |
| `DELETE … WHERE thread_id NOT IN (SELECT id FROM threads)` on `engine_input_echoes` and `engine_inputs` (`input-journal.ts:98`–`:99`)                                                                                        | history-sized, every open                                                      | fill `input-orphans` (durable)                                                                                                                                                                                           | nothing: every journal read filters by a live thread, so orphans are never read |
| `CREATE TRIGGER IF NOT EXISTS engine_inputs_delete` (`input-journal.ts:100`–`:103`)                                                                                                                                          | O(1)                                                                           | stays at open                                                                                                                                                                                                            | nothing                                                                         |
| the blocker rebuild (`transition-readiness.ts:54`–`:60`), read by 4c's readiness reads                                                                                                                                       | history-sized, every open                                                      | fill `readiness` (per boot)                                                                                                                                                                                              | 4c: the `rebuilt` check in the two answering methods                            |

E5.4 adds no fill, no fill cursor and no open-time statement. Fills run as E5.3's pump tasks and
never inside a receipt.

## Main fixes E5.4 depends on

Each is its own TypeScript PR on main. Its test is written first and must fail on main before the
fix. The native port then copies the fixed behaviour.

1. **Bounded open fills** (the E5.3 brief's prerequisite, `ace/fix-bounded-open-fills`). 4a waits
   for it to merge, then ports its queue readers. Its tests are listed in the E5.3 brief.
2. **A rolled-back receipt names its thread.**
   - **The bug.** `notifyNamingPrompt` (`engine/transcript-inputs.ts:221`–`:230`) calls
     `repo.onNamingPrompt` synchronously inside the receipt's `store.atomic` (`handler.ts:540`,
     inside `:205`). Production wires that to `ThreadTitles.namingPrompt`
     (`services/engine.ts:381`–`:383`, `thread-titles.ts:97`). It marks the thread in `attempted`
     at once and starts `generate` (and `generateBranch` for a worktree thread) by
     `queueMicrotask`, which runs whether the receipt commits or rolls back. A receipt rolls back
     after `notifyNamingPrompt` when the command policy (`bindCommandPolicy`, `index.ts:519`)
     throws after `accept`, or when the store fails the commit.
   - **What is observable.** For a rolled-back `thread.create`, the utility model is called for a
     thread that does not exist (its write finds no thread and is skipped), and a retry of the same
     create, with the same thread id, is never named, because the id is already in `attempted`.
     A send names only a thread whose title is still provisional, is not `New thread`, and equals
     `provisionalTitle(input)` (`transcript-inputs.ts:226`–`:228`). Take a thread created as
     "Fix the login flow" whose creation was accepted before the daemon restarted, so this process
     has no `attempted` entry for it and its title is still that provisional text. A rolled-back
     `thread.send` with the input "Fix the login flow" calls the model with a message the thread
     never accepted. Its `thread.updated` (`titleSource: "generated"`) lands, since the title is
     still `provisional`, and the attempt is used up. A worktree thread's branch is renamed from
     the same words.
   - **The commit hook.** `Store.atomic(run)` takes one argument (`store.ts:733` on main). The
     store's existing settlement mechanism is private. `transaction(run, outcome?)`
     (`store.ts:574`) queues a `TransactionOutcome` in `this.settlements` (`:151`). The outermost
     commit settles them in a `SettlementPass` after the transaction's events publish
     (`:645`–`:657`), and any rollback, nested or outermost, settles them as `rolledBack`. That
     outcome is not a general hook: it marks rows that publish themselves. A nested one splices
     the transaction's events, an outermost one suppresses `publishFresh`, and during
     `installingHistory` it throws `Store is busy`. So the fix adds a small public method on the
     same lists, with none of those effects:

     ```ts
     /** Runs `callback` once the outermost transaction commits, after its events publish; never on rollback. Outside a transaction, now. */
     afterCommit(callback: () => void): void;
     ```

     - It runs at once only when no SQLite transaction is open: `transactionEvents` is unset and
       `installingHistory` is false.
     - **History installation is an open transaction.** `installHistory` runs its own
       `BEGIN IMMEDIATE` (`store.ts:891` on main) and sets `installingHistory`. The nested
       wrapper (`:576`) then calls `run()` with no `BEGIN` and no savepoint. A callback
       registered there is pushed onto the same `commitCallbacks` list.
       - `installHistory` runs the list after its `COMMIT` and `readCache.evict` (`:902`–`:903`),
         in order, each in its own `try`, with a throw sent to `onError`.
       - Its `catch` (`:904`) clears the list without running it.
       - A nested `transaction` during installation records the list's length before `run()`
         and truncates back to it if `run()` throws, because there is no savepoint to undo its
         rows either.
       - The callbacks run after that commit, not after the events publish. An installation's
         events publish later, through `notifyHistory`, and a callback that waited for that
         could wait indefinitely.
     - Inside one, it is pushed onto a new private `commitCallbacks` list. A nested savepoint
       records the list's length when it begins and truncates back to it when it rolls back,
       as `settling` does for `settlements` (`:583`, `:604`). The outermost rollback clears the
       list (`:636`).
     - The outermost commit runs the callbacks in order, each as a `pass.step` after the last
       `publishFresh` and before the usage listeners. A throw goes through the pass's reporter
       (`onError`), never into the caller.
     - On `ace/daemon-rust-rewrite`, `nativeTransactions` (`native-writer/transaction.ts`) gets
       the same method on the same rule. E5.1 step 3's after-commit queue is the native
       release, and runs in the same position.

   - **The fix.** `notifyNamingPrompt` calls
     `repo.store.afterCommit(() => repo.onNamingPrompt?.(id, input))` instead of the port. The
     comment at `thread-titles.ts:96` ("the work starts after it commits") becomes true.
     `ThreadTitles` itself is unchanged.
   - **The installation test** (`history-storage.process.test.ts`, written with the fix): "a
     callback registered during history installation runs once after the install commits, and
     never when the install rolls back". It installs an archive whose `appendEvents` callback
     registers `store.afterCommit(spy)`. The spy has no calls until `installHistory` returns, then
     exactly one. A second install is cancelled after the registration (`cancelled()` turns true,
     so `installArchive` throws `History publication cancelled`, `history-storage.ts:13`), and its spy has no calls after the throw. A hook that ran at once
     would fail the first half, and one queued without the install's own drain would never run.
   - **The test** (`engine/thread-title.process.test.ts`, written first and red on main): "a
     receipt that rolls back after acceptance never asks for its thread's title, and its retry asks
     once". Through the harness with an `onNamingPrompt` spy, bind a command policy that calls
     `accept()` and then throws for the first `thread.create` only. Expect the command to throw and
     the spy to have no calls. Retry the same command (same thread id), and expect it to succeed
     with exactly one spy call carrying the create's input. On main the spy is called during the
     rolled-back receipt, so the first expectation fails.

## Seams: landing without E5.2 and E5.3

- **4a and 4b** use only E5.1's `EngineStore::atomic` and `Tx`, and tables the TypeScript opener
  created. Their seam tests reach the code through the facade reads (4a) and
  `probe.inputFacts` (4a, 4b) on homes the TypeScript engine wrote
  (`engineSeam({ seedWithTypeScript })`). The facade reads don't wait for `ready()`, and E5.1's
  `emptyCandidates()` (or E5.3's candidate scan, once it lands) lets `ready()` resolve.
- **The fold** calls E5.4 only through E5.3's `InputFacts`. Each method is 4a's or 4b's (decision
  5); one not yet landed is E5.3's `NotPorted` default, and E5.3's probe pass-through covers its
  fold seam.
- **E5.3's `Repo`** is what 4c to 4f call: `state`, `require_state`, `apply`, `save`, `evict`,
  `reserve`, `release`, `reserved_slot`, `cleaning`, `native_entity`, `entity_thread`, `reserved`,
  `workspace`, `next_command_id`, and the store reads through its ports and `Tx`. E5.3's names
  win.
- **E5.2's actor** is what 4f calls: `flush`, `poisoned`, `persistence_failed`, `schedule`,
  `sync_queue`, `stop`, `backlog`, `idle_due`, `session`, `steer_yield`.
- Seam tests live in `native-engine/commands.test.ts` (in process, switch on) and
  `native-engine/commands-home.process.test.ts` (homes the TypeScript engine wrote; the second
  process is the real edge). The seeding scripts are under `native-engine/testing/`. Each seam
  test names in a comment the (a) test that will show the same thing, and is deleted in the
  commit where that file first passes natively (E5.1 step 12).

## Proof

### The 31 class (a) files

Each runs alone, unchanged, switch off and on (rule 3). "First native green" is the earliest item
after which it can pass with the switch on; most deliver, which is E5.5 and E5.6. These are
expected results read from the files. Each round records the real result and amends this table
and E5.1 step 12's in its PR.

| File (`*.process.test.ts`) | Proves | First native green                                                        | Why                                                             |
| -------------------------- | ------ | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `metadata-commands`        | 4e     | **4e**                                                                    | Archive receipts and `not_implemented`; no session.             |
| `chat-thread`              | 4e     | 4f, if the delivery stub's one report doesn't fail its harness; else E5.6 | A create receipt's details; the woken send reaches E5.5's stub. |
| `guest-admission`          | 4d     | E5.7                                                                      | Seeds through `engine.guests.create`.                           |
| `queue-capacity`           | 4a     | E5.6                                                                      | Inputs awaiting admission.                                      |
| `input-leases`             | 4a     | E5.6                                                                      | Attachment retention across sends and steers.                   |
| `queue-context`            | 4a, 4d | E5.8                                                                      | Pages and edits; `:54` restarts.                                |
| `late-admission`           | 4b     | E5.6                                                                      | Late correlated admission.                                      |
| `catalog-mentions`         | 4b     | E5.6                                                                      | Native-command inputs and their signature.                      |
| `command-catalog`          | 4b     | E5.6                                                                      | The same, over the socket.                                      |
| `input-fate`               | 4c     | E5.6                                                                      | Fate after real deliveries.                                     |
| `queued-run-binding`       | 4b, 4c | E5.6 (steer cases E5.5)                                                   | Run binding.                                                    |
| `wake-run-inputs`          | 4c     | E5.6                                                                      | Origins of woken runs.                                          |
| `agent-trigger-admission`  | 4c     | E5.6                                                                      | Origins by trigger.                                             |
| `thread-title`             | 4c, 4e | E5.6                                                                      | `:45` and `:113` replay provider titles.                        |
| `stale-inputs`             | 4a     | E5.6                                                                      | Retirement after a real turn end.                               |
| `submission`               | 4d     | E5.6                                                                      | Uncertain copies after exits.                                   |
| `held-send-release`        | 4d     | E5.6 (`:184` E5.8)                                                        | Failed-send holds.                                              |
| `queue-resend-route`       | 4d     | E5.6                                                                      | Resend through the server route.                                |
| `queue-recovery`           | 4d     | E5.8                                                                      | `:386` and `:418` restart.                                      |
| `admission-recovery`       | 4d     | E5.8                                                                      | Continuations across restart.                                   |
| `acknowledged-response`    | 4d     | E5.6 (`:95` E5.8)                                                         | Acknowledgement before the daemon stopped.                      |
| `defaults`                 | 4e     | E5.6                                                                      | Catalog defaults (`models.prepare` is E5.6's).                  |
| `client-model-defaults`    | 4e     | E5.6                                                                      | The same.                                                       |
| `model-selection`          | 4e     | E5.6                                                                      | The same; `:174` steers (E5.5).                                 |
| `worktree-title`           | 4e     | E5.6                                                                      | Prepared workspaces and provider titles.                        |
| `organization`             | 4e     | E5.10                                                                     | PR settle.                                                      |
| `pr-settle-once`           | 4e     | E5.10                                                                     | The same.                                                       |
| `switch-admission`         | 4d     | E5.9                                                                      | Executing the switch.                                           |
| `queue-selection`          | 4d     | E5.9                                                                      | Selecting steers, applied by the switch.                        |
| `queue-transitions`        | 4d     | E5.9                                                                      | Fork and switch of held queues.                                 |
| `overload-delivery`        | 4f     | E5.8                                                                      | Mailbox overload; `restart=true` reopens.                       |

Seven of these are also in later items' rows (`submission`, `input-fate`, `input-leases`,
`held-send-release` in E5.5's, `guest-admission` in E5.7's, `model-selection` in E5.6's,
`switch-admission` in E5.9's). A file is green when it first passes, whichever item that is.

### Class (b) cases to move

- `edited-context.test.ts` (four cases) → `rules.rs` (4a).
- `retired-bot-threads.test.ts` (two cases) → `commands/guest.rs` (4d).

### Seam tests

Each runs with the switch on (`describe.runIf(engineBackend() === "native")`) and is deleted when
the (a) test in its comment passes natively.

**4a** (`commands-home.process.test.ts`):

- "a queue the TypeScript engine wrote reads the same natively: snapshot, first page, next page,
  total". The seed has three queued sends (one that fell back from a steer), one uncertain, one
  child result, and a `stopped` hold. Asserted as literals: the child result absent, `fellBack`
  on the fallen-back message, the uncertain one `state: "uncertain"`, `exited` absent, `next` set.
  (a): `queue-context.process` `:15`.
- "a page refuses a stale revision, a cursor without a revision and an unknown cursor, with the
  TypeScript messages". (a): `queue-context.process` `:15`.
- "commandFailure and commandExecution read a removed, a cancelled and a done intent".
  (a): `input-fate.process` `:38`.
- "a turn's end retires only the uncertain sends of its own session generation". Through
  `probe.inputFacts("retireEndedTurnInputs", …)` on a seed with uncertain sends submitted in
  generations 1 and 2: ending generation 2 retires its sends, generation 1's stay, and the hold
  stays `uncertain`. Ending generation 1 then lifts it, with one `queue.updated` each.
  (a): `stale-inputs.process` `:47`.

**4b** (`commands-home.process.test.ts`):

- "an echo correlates natively to the input the TypeScript engine sent: by native identity, by
  signature in its own generation, and not in another generation". `probe.inputFacts("inputs.correlate", …)`
  returns the input's key, its origin and `synthetic: false`, or the fact unchanged.
  (a): `late-admission.process` `:15`.
- "a Claude input with a slash command correlates by its first admission's text".
  (a): `catalog-mentions.process` `:10`.
- "a started run takes the inputs its generation was sent, and no others"
  (`bindStartedRun`). (a): `queued-run-binding.process` `:101`.

**4c** (`commands-home.process.test.ts`):

- "inputFate follows its precedence on a TypeScript-written home". One row per rule, asserted as
  whole fates: a resent uncertain input is `replaced` (not `uncertain`); an uncertain one in the
  queue is `uncertain` (not `waiting`); a waiting one is `waiting` even with a run recorded; a
  Stop-cancelled written input is `failed` with `Cancelled before delivery` (not `delivered`); a
  removed one is `removed`; a written one with no intent is `delivered`.
  (a): `input-fate.process` `:8`, `:38`, `:66`, `:115`.

**4d** (`commands-home.process.test.ts`, `commands.test.ts`):

- "queue edits on a TypeScript-written queue commit natively: edit, move, remove and pause, each a
  single revision bump with one `queue.updated`". (a): `queue-recovery.process` `:17`.
- "two receipts on one revision: the first wins, the second gets `queue_conflict` and commits
  nothing". (a): `queue-recovery.process` `:73`.
- "removing the failed head releases a `not_sent` hold; removing one behind it keeps the hold".
  (a): `held-send-release.process` `:62`, `:93`.
- "editing a selecting message to steer, on a provider that can't steer, keeps it queued with its
  selection; on one that can, while the tree works, it splits into the steer and a switch placed
  right after it". (a): `queue-selection.process` `:219`, `:84`.
- "a guest thread and Spade's threads refuse with their titles and details" (seeded with the
  TypeScript engine). (a): `guest-admission.process` `:5`.
- "a refused receipt before the atomic step writes nothing and releases no wake" (`headSeq`
  unchanged, the probe's `woken()` empty). (a): `metadata-commands.process` `:54`.
- "a queue command whose policy throws after accepting rolls back: no revision bump, no wake, and
  the deadline timer neither cancelled nor re-armed". The port log shows no `setTimer` and no
  cancel for a `thread.limit` `resume_at_reset` that rolled back. (a): `engine/reliability.process`
  (the receipt cases).

**4e** (`commands.test.ts`):

- "a Stop keeps waiting sends queued under a `stopped` hold, defers a claimed send that was never
  submitted, and cancels a submitted one". Waiting sends are still `queued` and in the snapshot;
  the claimed one is back to `queued`; the submitted one is `failed` with
  `Cancelled before delivery` and its item `notAnswered: "stopped"`; a pending resume is failed.
  (a): `stop-queue.process`, `input-fate.process` `:115`.
- "create and send receipts write their intent, queue and title rows natively".
  (a): `queued-run-binding.process` `:324`.
- "a steer that saw no run (`runId: null`) queues when a root run is active and stays a steer when
  none is; one aimed at an ended run queues, with an omitted delivery left omitted".
  (a): `queue-recovery.process` `:151`, `:197`, `:324`.
- "the receipt's refusals win in the TypeScript order". A table over seeded conditions:
  `thread_deleting`, `cursor_cli_retired`, `workspace_change_in_progress`, `message_too_large` (65
  parts), `not_implemented`, `thread_not_found`, `agent_not_found`, `stale_interrupt`,
  `unsupported_goal`, `engine_capacity_exceeded` (`maxActiveThreads: 1`),
  `queue_capacity_exceeded` (256 in flight). Each row asserts the whole result object.
- "a refused send commits what it did first": `queue_capacity_exceeded` leaves the restart streak
  cleared; `engine_capacity_exceeded` leaves the uncertain input retired and the `stopped` hold
  released, each with its `queue.updated`.
- "creation with a catalog selects and validates through it": a catalog port resolving the
  default gives the concrete model id; an unknown explicit model gets `model_unavailable` with one
  `onModelUnavailable` call; the catalog's permission modes decide `permission_mode_unsupported`;
  with no catalog a default sentinel is dropped and an explicit model kept.
  (a): `client-model-defaults.process` `:27`, `:297`.
- "an absent owner is accepted only without a reservation; an unknown owner is refused with and
  without one; release frees the slot once". (a): `worktree-title.process` `:12`.
- "a receipt that rolls back never names its thread" (no `onNamingPrompt` call), and "one that
  commits calls it once, after commit". (a): `thread-title.process` `:22`.
- "a receipt that reaches an unported command fails NotPorted naming the item, and commits
  nothing" (`thread.fork` → E5.9). Deleted with E5.10's switch-on run.
- The receipt bench (below).

**4f** (`commands.test.ts`):

- "a send on a held queue is never dispatched". `work` returns at the hold (`index.ts:1358`–`:1361`)
  before it marks anything `queued` (`:1370`), so the intent stays `pending`. Expect no
  `delivery.run` call (the stub's report never appears in `onError`), the intent's status still
  `pending`, and the queue snapshot unchanged.
- "a runnable send passes the steering reads and reaches delivery, which reports E5.5 once". This
  covers `yielded`, `route` and `readyForInput` on a probe-attached session.
  (a): `queued-run-binding.process` `:57`.

### Cargo tests

These sit beside their functions. Tests of new behaviour are marked as such in the commit.

- `queue/record.rs`: `exitedAfter` over every `(before, patch)` combination, `lastFailure`
  clearing, `shown`.
- `queue/page.rs`: the 512 KiB cut always keeps the first message; `next` only when a row was
  left over.
- `queue/store.rs`: `move` (to the front, after a message, unknown, itself); the reason table of
  `reconcileUncertainty`.
- `ace-json::bounded`: each of the four limits at its boundary.
- `inputs/signature.rs`: `withoutHandoffEnvelope` with a v1 manifest, a tagged envelope, an
  invalid manifest, a too-long envelope and a multi-byte prefix. New: no (a) file reaches the
  invalid and too-long branches.
- `commands/admissions.rs`: `authorized` with an absent, a known, a foreign and an unknown owner,
  with and without a reservation.
- `queue/store.rs`: a thread with no `engine_queue` row reads the default settings, and its
  pending sends are counted and listed from `intents` (moved with the main fix's cases, if that PR
  adds unit cases; else proven by its process tests).

## Benches and the cross-mode run

- **The receipt bench is 4e's.** 4d can't accept a send. 4e times 10,000 accepted `thread.send`
  receipts on queues held `manual`, so nothing delivers. A thread takes at most 256 inputs in
  flight (`recovery.ts:135`), and held sends count, so the bench runs **40 batches of 250**. Each
  batch gets a fresh thread (create, then `queue.pause`), made outside the timed region. It
  asserts every timed receipt is `ok: true`, so a refusal can't creep into the figures. It reports
  p50 and p99 with the switch off and on, from a loop in `commands.test.ts` behind a
  `--bench` filter that doesn't run by default. That covers the synchronous part of `sendReceipt`.
  E5.8 runs `bench/head-of-line.ts` in full.
- E5.4 adds no open-time work, so it has no cold-clone measurement; the fills' figures are E5.3's.
- The E5 cross-mode list needs restart (E5.8). Until then `commands-home.process.test.ts` is the
  proof that E5.4 reads and acts on TypeScript-written homes. The reverse direction is the
  cross-mode run's.

## Files

- `native/daemon/crates/ace-engine/src/{intents,queue,inputs,commands,models,release}/…`,
  `rules.rs`, and `queue/fold_hooks.rs` (with the one `impl InputFacts for State` move out of
  E5.3's `collaborators.rs`). `commands.rs` keeps `Commands` and `quiescent`, which 4f fills: a
  thread with a running sends task is not quiescent.
- In later items' files, only what "The receipt dependencies" lists, each with its header line:
  `steering/{notes,selection,route}.rs`, `sessions/metadata.rs`,
  `transitions/{state,readiness,switch_admission,switch_ready}.rs`, `access/storage.rs`,
  `liveness/{stop_intents,stop_scope}.rs`, `models/select.rs`, `release/reclaim.rs`, and the stubs.
- `ace-core/src/{person_input,provider_admission}.rs`, `ace-projection/src/attention.rs`,
  `ace-adapter-claude/src/input.rs`, `ace-adapter-pi/src/input.rs`, `ace-json/src/bounded.rs` and
  the one re-pointed call in `ace-adapter-cursor`.
- Bindings: `ace-daemon-node/src/engine/{intents,queue,inputs,commands,probe_commands}.rs`. Shell:
  `apps/daemon/src/native-engine/{intents,queue,inputs,commands}.ts`, `commands.test.ts`,
  `commands-home.process.test.ts`, `testing/`. The E5.1 amendments, if E5.1 has merged without
  them: `ports.rs`, `engine/ports.rs`, `native-engine/ports.ts`, `testing.ts`.
- `docs/engine/porting-guide.md` (the row corrections), E5.1 step 12's table, and E5.3's
  `InputFacts` row (`rootRunStart` is E5.5's), amended per round.

## Must not

- Edit E5.2's or E5.3's files beyond the one `impl` move, or any TypeScript engine module
  (`git diff origin/ace/daemon-rust-rewrite -- apps/daemon/src/engine` is empty).
- Run any DDL from Rust, or any history-sized statement at open.
- Make an unported branch succeed, or return a `CommandResult` for one.
- Run a wake, a timer change, a naming prompt or a task inside the receipt.
- Roll back a refusal, or commit a throw.
- Call a JS port while holding a `with_state` borrow, or hold a transaction across an await.
- Change a table, column, index, statement text or JSON shape, or reorder the receipt's checks.
- Copy a package helper's TypeScript tests into Rust, or add a parity harness.
- Run the full suite, `bun run check` or any tier; one file at a time (rule 3).

## Reviewer checks

- The receipt's checks follow `handler.ts`'s order. The refusal table matches its sources
  character for character. A refusal returns `Ok` and commits; a stub throws and rolls back.
- Every receipt statement is on the outer stack's `Tx`; wakes, `schedule`, the naming prompt and
  the reclaim's retire are after-commit only.
- `queuePage` throws plain `Error`s; `admitCreation` returns strings; `Owner::Unknown` never
  authorizes.
- `EngineModels` is built with or without a catalog, and `select`, `permissionCapabilities` and
  `knownPermissionCapabilities` call the catalog port synchronously exactly where the TypeScript
  does.
- The ported files of later items carry their header line, and the guide's rows for E5.5, E5.6,
  E5.7, E5.8, E5.9 and E5.10 drop what moved.
- Every `InputFacts` method is 4a's or 4b's (or E5.5's `rootRunStart`), and none waits on 4c–4f.
- `work` reaches ordinary delivery when nothing is yielded; `yielded` is ported, not stubbed.
- No queue reader defaults pending work: with the row missing, counts and messages still come from
  `intents`. `retains` checks live intents until `queue-attachments` is complete. Readiness answers
  false until `rebuilt`.
- Each seam test names the (a) test that replaces it.

## Decided (2026-11-24)

The owner's answers to the first revision's questions, all as Codex (gpt-6.2-sol, high)
recommended:

1. Port the synchronous receipt dependencies, including switch admission for a selecting steer
   and guard release for a Stop; execution stays with the owners.
2. Command-time holds are 4d's; E5.8 executes deadlines.
3. `readMessageFacts` moves to E5.5.
4. Six rounds, with the dependency and proof fixes above.
5. `workspaceDirectory`, `portableHandoff` and `linkCreatedThread` are synchronous TypeScript ports
   on the shared stack, keeping `realpathSync`'s spelling.
6. Helpers go to their owners' crates, with JavaScript's serialization and error bytes kept.
7. The history-sized open-time scans are fixed on main first, before E5.3, as the E5.3 brief's
   fills (idle, 256 rows a step, resumable, with a done signal). E5.4 ports the readers'
   fallbacks once that fix is on main.
8. Queue rows at open: the main fix's `queue-rows` fill. Until it finishes, readers default only
   the row's settings and always read pending work from `intents`.
9. Naming on a rolled-back receipt: fix TypeScript to match ("Main fixes E5.4 depends on").
