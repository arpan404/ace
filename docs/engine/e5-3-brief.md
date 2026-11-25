# E5.3: persistence in Rust (switch `ACE_ENGINE=native`, default off)

Part of the [engine porting guide](porting-guide.md). Its rules 1–16, "Files per work item" and
"For every E5 item" apply unchanged, and so does the [E5.1 brief](e5-1-brief.md): its executor,
ports, `EngineStore`, test seam and re-entrancy rules are the machinery this item runs on. Where
this brief is more exact, it wins. Read
[ADR 0223](../adr/0223-the-engine-and-adapters-move-to-rust-behind-the-same-interfaces.md) §4, §5
and §8, [ADR 0222](../adr/0222-the-event-store-moves-to-rust-behind-the-same-store.md), the store
guide's [phase 5](../store/porting-guide.md) (Task 5.3, the event writer, and Task 5.5, the
transaction stack), and ADR 0170 first.

E5.3 ports the engine's persistence: the repository's own state (the resident-snapshot cache,
slots, the admission rows and its reads), the snapshot (header plus native-keyed records), the
record dictionaries and their shared cache budget, text appends, item metadata, the schema and
snapshot version checks, the provider-fact fold's persistence frame, execution provenance and
store generations. It also ports the startup candidate scan E5.1 declared, in bounded slices.
E5.3 runs in parallel with E5.2 and E5.4 and lands after E5.1.

## The constraints

1. **Formats do not change.** Tables, columns, indexes, JSON shapes and `engineSchemaVersion` 9
   (`engine/schema-version.ts:6`) stay as they are. Every row Rust writes is a row the TypeScript
   would have written for the same input: the same `thread_state.state` header, the same
   `engine_state_records` sections, keys and values, the same `engine_state_appends` patches.
   JSON goes through `ace-json` (rule 8), so key order, numbers and lone surrogates match
   `JSON.stringify`.
2. **A home written with the switch on opens with it off,** and the reverse. The cross-mode run
   below proves it.
3. **ADR 0170.** Open does no work that grows with history: no new `CREATE INDEX`, no full-table
   pass. The startup scan reads in slices of 256 rows by primary key, one pump step per slice and
   per thread recovered (ADR 0223 §5).

## Decisions this brief makes

1. **The event rows are written by the store, never by engine SQL.** The TypeScript engine
   appends events with `store.appendEvents(threadId, payloads, at)` (`repository.ts:322`,
   `provider-facts.ts:78`, `:85`). That call runs the store's whole event writer
   (`event-writer.ts:78`): sequences, payload storage, history, status columns, long threads,
   search, MCP intents, the write hooks (`store.ts:1176`–`:1185`) and `recordEvents`, which hands
   the events to the open native context. Store phase 5 has moved the row writes, sequences and
   fold into `ace-store`, but the orchestration around them is still TypeScript. So Rust does not
   write `events`, `threads`, `items` or `payloads` rows itself. It calls one new shell port,
   `writeEvents(threadId, payloadsJson, at)`, which runs `store.appendEvents` inside the open
   transaction. The store publishes those events through its own `recordEvents`, so the engine
   never also calls E5.1's `appendEvents(json)` for them. That port stays for events Rust has
   already written itself, of which E5.3 has none. One writer, one statement set, no duplicate SQL.
2. **The engine's own tables are engine SQL, on the store's connection.** `thread_state`,
   `engine_state_records`, `engine_state_appends`, `engine_slots`, `engine_provider_frames`,
   `engine_store_generations`, and the admission statements on `engine_state_records` and
   `intents` (`repository.ts:153`–`:171`) are read and written by `ace-engine` through
   `ace_store::stmt_cache` on the connection E5.1's factory hands the engine (ADR 0223 §5). The
   SQL text is copied from the TypeScript call site it replaces, and the module doc comment names
   that line. The store has no statements for these tables, so there is nothing to reuse;
   two engines never run at once, so the copy is a port, not a duplicate.
3. **Where the TypeScript wraps a read in `store.atomic`, Rust wraps it in `EngineStore::atomic`;
   where it does not, Rust doesn't either.** `atomic` flushes the live buffer first (the shell's
   `open` runs `host.flush()`), so this is behaviour, not style: `state()` (`repository.ts:210`)
   reads `thread_state` outside a transaction and must not flush, while `reserve()` (`:517`) runs
   inside one.
4. **Migrations stay TypeScript** until the TypeScript engine is deleted, and their data work moves
   into bounded fills on main first ("Prerequisite fix on main"). Reasons are in "Migrations".
5. **The record dictionaries are lazy in Rust too.** The Rust core's `ThreadState` holds plain
   `IndexMap`s (`ace-core/src/state.rs:226`–`:230`). Loading every record of a thread into them
   would make a thread's first touch cost its whole history and break the record budget, so the
   sections become a lazy, budgeted map type in `ace-core` (step 3). This is the one change outside
   `ace-engine` that needs a core reviewer.
6. **Calls into modules other items own go through E5.3's collaborator traits** (step 7). Until an
   item lands, each trait method fails with `NotPorted` naming that item. E5.3 never edits another
   E5 item's files.
7. **No borrow across a port.** No `with_state` or `Snapshot` borrow is held across a port call, a
   callback into the engine, or `EngineStore::atomic` (step 8).

## Prerequisite fix on main (TypeScript, its own PR, before E5.3)

> **Status (owner decision, 2026-11-24): no TypeScript fix.** Bugs found in the TypeScript daemon
> are fixed in the Rust port only, never on main. This section is therefore **not** a PR to main.
> E5.3 ports today's open-time statements as they are, in the same order. The bounded open-time
> design (ADR 0170) becomes a later Rust-only item, starting from this text and the lessons on
> `ace/fix-bounded-open-fills`: an unbounded per-thread rebuild, divergence from the native
> transaction shell, and the provisional workspace fence. The queue that shows empty while live
> intents exist is fixed in Rust in E5.4a, as a recorded difference with a native-only test.

The opener (step 1) runs the TypeScript repository's constructors on every native boot, and those
constructors do history-sized data work at open today. That breaks ADR 0170 §1–§3 on main with the
switch off as much as on, so it is a bug on main, fixed first in its own PR. E5.3 then ports the
bounded version, never today's.

**The rule.** Each constructor keeps only its schema setup at open (`CREATE … IF NOT EXISTS`, the
version and column checks, `requireEngineColumns`), which is O(1) on an existing home. Every data
pass becomes a **fill**: an idle, bounded, resumable pass that the engine starts after
construction, plus a reader rule that is correct before the fill completes (ADR 0170 §3, "readers
fall back to the slower path that is already correct"). The constructors no longer read or write
rows.

**The fill driver** (`apps/daemon/src/engine/open-fills.ts`, new). One driver per `Engine`, started
at the end of the constructor, running fill steps on idle ticks (`setImmediate`, one step per
tick, yielding to I/O in between), each step one `store.atomic` over **at most 256 rows**, paged by
primary key or rowid from a saved cursor. Each fill exposes `complete(): boolean` and
`completed: Promise<void>` (its completion signal). A fill whose result is durable saves its cursor, and `done`, in a side table
`engine_open_fills(name TEXT PRIMARY KEY, cursor TEXT, done INTEGER NOT NULL DEFAULT 0)`, created
`IF NOT EXISTS` at open (empty on a fresh home; an older build ignores it). This PR adds it, so by
E5.3 it is an existing table and E5.3's "formats do not change" holds. A fill whose result is per
boot keeps its cursor in memory and restarts next boot: a crash redoes it, which is right for data
derived per boot. `close()` stops the driver before the modules' close steps. Tests use the `batchScheduler`
port for the tick, so a `ManualClock` test can drive it.

The data work on main today, and what each becomes:

| Today (open time)                                                                                                                                                                                                        | Fill                                                                                                                                                                                                                                                                                                               | Readers before the fill completes                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSERT OR IGNORE INTO engine_queue(thread_id) SELECT thread_id FROM thread_state` (`queue-store.ts:75`)                                                                                                                 | `queue-rows`, durable: `thread_state` by `rowid`, 256 a step, `INSERT OR IGNORE` the page's ids                                                                                                                                                                                                                    | Metadata defaults, but the pending work is always read from `intents`: see **Queue reads** below.                                                                                                                                                                                                                                                                                                                                        |
| Re-track attachments of every live intent (`queue-store.ts:86`–`:93`)                                                                                                                                                    | `queue-attachments`, durable: `intents` by `id` over the same predicate, 256 a step, `track` per row                                                                                                                                                                                                               | Rows written by `track` at enqueue and edit (`:344`, `:363`) are current; the pass repairs intents that predate them. Until `complete()`, `retainsAttachment` for a thread also checks that thread's live intents' payloads for the hash (bounded by its live intents), so no attachment a live intent needs reads as unretained.                                                                                                        |
| `DELETE FROM engine_transition_blockers` and rebuild from every agent record (`transition-readiness.ts:54`–`:60`)                                                                                                        | `readiness`, per boot: threads in `thread_id` order from two sources merged, agent records (`engine_state_records WHERE section='agents'`, primary key) and existing blockers (`engine_transition_blockers`, primary key), so a thread with blockers and no agent rows is visited; 256 rows read or written a step | Per-thread bounded rebuild; until a thread's rebuild has committed it reads as not ready, never as done: see **Readiness** below.                                                                                                                                                                                                                                                                                                        |
| `DELETE FROM engine_input_echoes` / `engine_inputs WHERE thread_id NOT IN (SELECT id FROM threads)` (`input-journal.ts:98`–`:99`)                                                                                        | `input-orphans`, durable: each table by `rowid`, 256 a step, deleting the page's rows whose thread is gone                                                                                                                                                                                                         | Orphans belong to deleted threads, and every reader filters by `thread_id` of a live thread, so they are never read. The `engine_inputs_delete` trigger already removes new orphans.                                                                                                                                                                                                                                                     |
| `migrateEmptyCursorThreads` (`cursor-empty-migration.ts:6`)                                                                                                                                                              | `cursor-empty`, durable: `threads` by `rowid`, 256 a step, the same predicate per page                                                                                                                                                                                                                             | The session open of a Cursor thread (`session-open-route.ts`) first applies the same check to that one thread (bounded), so a thread opened before the fill reaches it gets the same backend it would have had.                                                                                                                                                                                                                          |
| `CREATE INDEX IF NOT EXISTS` on tables that grow with history (repository, queue-store, intents, input-journal, interaction-ledger, attachment-correlations, title-input, thread-cleanup-journal, engine-record-indexes) | none, if every supported home has them                                                                                                                                                                                                                                                                             | The daemon refuses homes older than schema 14. The PR lists each such index and the release that added it. One every supported home already has is O(1) at open and stays. One a supported home can lack moves out of open, ADR 0170 §2: readers stay correct without it (they are, since an index never changes results), and it is built as a side effect of a fill only if the owner approves that cost, else filed as its own issue. |

**Queue reads.** A missing `engine_queue` row defaults the **metadata** only: revision 0, not
paused, not limited, no continuation, no trigger, hold token 0, not exited. The pending work is
never defaulted: every reader still reads the thread's live intents. So `get` (`:117`) returns the
default metadata with `pendingCount` from `count(id)` (`:186`) instead of throwing
`Missing queue metadata`; `snapshot` (`:242`) and `page` keep their intent queries
(`:255`, the `messages` rows) whether or not the row exists, and take only `revision`, `paused`,
`reason`, `resumeAt` and the exit from the defaults. Every writer calls `ensure` (`:104`) before
its `UPDATE`; the PR lists each `UPDATE engine_queue` site (queue-store, `recovery.ts:98`) and
adds `ensure` where missing. `runnableThreads` (`intents.ts:299`) uses `LEFT JOIN engine_queue`
and reads a null as the default (`COALESCE(q.paused,0)=0`), so a thread with pending intents and
no row still runs. `thread-organization.ts:60` and `thread-move.ts:130` read a missing row as not
held, which is the default. The recovery scan's `engine_queue` source needs no change.

**This is already a bug on main.** Today's `snapshot()` returns `pendingCount: 0, messages: []`
when the row is absent (`queue-store.ts:242`–`:254`) without reading `intents`, so any thread
with live intents and no queue row shows an empty queue. Rows are ensured only by
`create-thread.ts:101` and `imported-thread.ts:41`, while `handler.ts:536` admits intents for any
thread the engine knows; the open backfill re-creates missing rows only at the next boot. The PR
writes the test first, "a thread with a pending send and no queue row shows that send in its
queue snapshot and page", seeding the row's absence by deleting it in the test; it must be red on
main before the fix. If no production path can reach the state, the test still stands, because
the fill above makes it reachable until the fill completes.

**Readiness.** Blockers decide `agentsReady` (`transition-readiness.ts:110`), so `quiescent`
(`repository.ts:496`), settle, transitions and switch admission read them. A thread's blockers are
trusted only once its rebuild has **committed** this boot. Until then the thread is not ready.

- **Bounded steps.** Rebuilding one thread is a sequence of steps of at most 256 rows read or
  written: the first step deletes up to 256 of the thread's blockers (repeated until none are
  left), the next ones read its agent records in primary-key order from a saved `(thread_id, key)`
  cursor and `put` the blockers of those that are not ready. A reader never runs a rebuild inline:
  a thread with 1,000 agents is never rebuilt inside the read or the transaction that asked.
- **Completion on commit only.** Each step runs in its own `store.atomic` with a transaction
  outcome (`Store.atomic(run, outcome)`). The in-memory progress (the cursor, and the thread's
  move into `rebuilt`) is applied in the outcome's `committed` callback, never in the body. On
  `rolledBack` nothing is recorded, and the step runs again. So a rolled-back rebuild cannot leave
  the thread marked rebuilt.
- **Readers: one check, at two entry points.** Blocker state is read only through
  `TransitionReadiness`, and both of its answering methods check `rebuilt(threadId)` first:
  `agentsReady` (`transition-readiness.ts:88`) and `acceptsPersonInput` (`:92`). The second does
  not read blockers today (it calls the core's `acceptsPersonInput` on the state alone), but it
  answers "free for the person's next message", which is a readiness answer, so it gets the same
  check: while the thread is not rebuilt it answers **false** (not free; the message queues, as for
  a busy thread). While not rebuilt, `agentsReady` answers false, so `quiescent`
  (`transition-history.ts:8`) answers false: never ready, never done.
- **Every reader, and how it gets the answer** (from a grep of `quiescent(`,
  `acceptsPersonInput(`, `agentsReady(` and the table name; the PR re-greps and amends this list):

  | Call site                                                                                                       | Through                                     | Before rebuild                                                                                                                                                                 |
  | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `repository.ts:500` `quiescent`, `:505` `acceptsPersonInput`                                                    | `agentsReady`, `acceptsPersonInput`         | the two checked entry points                                                                                                                                                   |
  | `actor.ts:459`, `thread-liveness.ts:113`, `index.ts:280`, `:283`, `sessions.ts:350`, `transition-history.ts:61` | `repo.quiescent`                            | synchronous; "not quiescent" only withholds (no settle, no release, no idle close), so false is safe                                                                           |
  | `switch-recovery.ts:14`, `message-facts.ts:73`, `:85`                                                           | `repo.quiescent`, `repo.acceptsPersonInput` | synchronous; false keeps the thread treated as busy (queue, no recovery switch); the PR confirms neither branch acts on false                                                  |
  | `steer-selection.ts:66`, `steer-lane.ts:119`                                                                    | `repo.quiescent`                            | false would choose steering into a turn that may not exist: the caller first `await readiness.whenRebuilt(id)` (both run in async delivery paths)                              |
  | `transition-handler.ts:156`, `:171`, `workspace-change.ts:107`, `:165`, `:180`                                  | `repo.quiescent`                            | false refuses with `fork_tree_is_live` or `thread_tree_is_live`, a wrong refusal: the async transition path awaits `whenRebuilt` for the thread and each peer before the check |
  | `provider-facts.ts:204` `refreshBlocked`, `repository.ts:320`, `:398` `capture`                                 | writers                                     | run as today (next bullet)                                                                                                                                                     |

  No other module reads `engine_transition_blockers`. A test reads `acceptsPersonInput` and
  `quiescent` for a thread whose last-boot blockers say ready but whose rebuild has not committed,
  and expects false from both.

- **Asking moves the thread to the front** of the pass's queue, so a wait is a few bounded steps,
  not the whole pass.
- **Writers during a rebuild.** `capture` and `update` run as today on the thread's current
  state; the rebuild's later steps read the stored records that the same commits wrote, so they
  agree. A thread whose rebuild has committed is skipped by the pass.
- **Zero agent rows.** The pass visits every thread that has blockers, not only threads with agent
  records, and deletes the blockers of a thread with no agent rows (a purged or broken thread), so
  a stale blocker cannot keep a thread unsettled forever.
- No reader queries blockers across threads; the PR confirms by grep and adds a test that fails
  if one appears before `complete()`.

**Readiness ordering.** `ready()` still resolves only after the startup recovery pass (E5.1, E5.8).
Recovery reads queues and readiness for the threads it recovers, and those reads take the fallbacks
above, so recovery never waits for a fill and never reads partial data. Fills run after `ready()` is
armed and interleave with it; they never hold `ready()` back.

**Tests (in that PR).** Behaviour tests through the public API, one per fill, named after the
behaviour: "a thread whose queue row was never created still runs its pending send" (seed with the
row deleted); "a thread with a pending send and no queue row shows that send in its queue snapshot
and page" (red on main first, above); "a thread blocked at the last stop is not reported ready
before its rebuild commits"; "a readiness rebuild rolled back with its transaction leaves the
thread not ready, and the redone step marks it rebuilt"; "a thread with 1,000 agents is rebuilt
in at least four bounded steps and reads not ready until the last one commits"; "a transition on
a thread not yet rebuilt waits for its rebuild, then admits"; "stale blockers of a thread with no
agent records are removed"; "a Cursor thread opened before the migration fill reaches it opens on the SDK backend";
"orphaned input rows are gone once the fill completes, and a stop mid-fill resumes from its
cursor". Plus one open-time measurement per ADR 0170 §6: a cold APFS clone of a seeded large home,
first open before and after, in the PR. No daemon on a copy of `~/.ace`.

E5.3 ports the fill driver and the five fills into `ace-engine` (`repository/fills/`), same SQL,
same cursors and same `engine_open_fills` rows, run as pump tasks on the `Work` lane, one step per
poll. The readers' fallbacks live with their owners (E5.4 queue, E5.6 Cursor open, E5.9 readiness)
and ask the fill state through `State.repo.fills` (`complete(name)`, `rebuilt(thread)`,
`when_rebuilt(thread)` for readiness). Until the owner lands, its reader is `NotPorted` like the rest of
its module.

## Module map

Rust paths are in `native/daemon/crates/ace-engine/src/`. Split each module into the files
listed, all under 400 lines.

| TypeScript (`apps/daemon/src/engine/`)                                                                                                                                                                                                                                | What it does                                                                                                                        | Rust                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `repository.ts:64`–`:172` (`EngineRepository`, constructor)                                                                                                                                                                                                           | open sequence, statements, the snapshot map                                                                                         | `repository/mod.rs` (`Repo`), `repository/open.rs`; the DDL itself stays TypeScript (Migrations)                    |
| `repository.ts:173`–`:199` (`nextCommandId`, `acknowledgeCommand`, `beginSessionOpen`, `resetAdmission`, `finishSessionOpen`, `recoveryAcknowledgement`)                                                                                                              | command ids, admission rows, the opening set                                                                                        | `repository/admission.rs`                                                                                           |
| `repository.ts:200`–`:254`, `:294`–`:355` (`syncSnapshots`, `state`, `deadline`, `setSilenceMs`, `evict`, `requireState`, `save`, `trim`, `drop`, `retire`)                                                                                                           | the resident-snapshot cache, rollback sync, save                                                                                    | `repository/residency.rs`, `repository/save.rs`                                                                     |
| `repository.ts:255`–`:282` (`recoveryStates`); `states` (`:283`–`:292`) is not ported                                                                                                                                                                                 | startup candidates                                                                                                                  | `repository/candidates.rs` (fills E5.1's `recovery_candidates`)                                                     |
| `repository.ts:356`–`:449` (`attributeAction`, `stream`, `apply`)                                                                                                                                                                                                     | the live path's persistence half, the fold's frame                                                                                  | `repository/stream.rs`, `repository/apply.rs`                                                                       |
| `repository.ts:496`–`:543` (`quiescent`, `acceptsPersonInput`, `reserve`, `release`, `reservedSlot`)                                                                                                                                                                  | slots and the two readiness questions                                                                                               | `repository/slots.rs`; `quiescent` and `acceptsPersonInput` call E5.9's readiness through the collaborator trait    |
| `repository.ts:544`–`:672`, `:715`–`:756` (`readRawBlob`, `nativeEntity`, `entityThread`, `answer`, `reserved`, `cancelled`, `engineQueueFact`, `latestIntent`, `commandsSince`, `queuedCount`, `inputCapacity`, `workspace`, `clearIncompleteBlobs`, `captureFrame`) | point reads and small writes                                                                                                        | `repository/reads.rs`, `repository/frames.rs` (`captureFrame`)                                                      |
| `repository.ts:450`–`:495`, `:508`, `:655`–`:666`, `:673`–`:714`                                                                                                                                                                                                      | one-line delegations to transcript inputs, intents, stop intents, session metadata, the interaction ledger                          | **not E5.3**: each owner's module (E5.4, E5.6, E5.7, E5.10); `Repo` holds no field for them                         |
| `repository.ts:760` (`timeOrderedIdSource`)                                                                                                                                                                                                                           | default ids                                                                                                                         | E5.1's id service (already ported)                                                                                  |
| `persistence.ts:19`–`:155` (`Snapshot` constructor, `own`)                                                                                                                                                                                                            | wraps a state's sections in record dictionaries, names the sections                                                                 | `snapshot/mod.rs` (`Snapshot`), `snapshot/sections.rs`                                                              |
| `persistence.ts:156`–`:160`, `:263`–`:296` (`release`, `begin`, `retainChanges`, `persist`, `committed`, `flush`)                                                                                                                                                     | the snapshot's transaction lifecycle                                                                                                | `snapshot/lifecycle.rs`                                                                                             |
| `persistence.ts:161`–`:211`, `:278` (`prepare`, `remember`, `delta`, `streamItem`)                                                                                                                                                                                    | text-append and metadata plumbing                                                                                                   | `snapshot/appends.rs`                                                                                               |
| `persistence.ts:212`–`:239` (`deadline`, `setSilenceMs`, `updateDeadlines`)                                                                                                                                                                                           | the deadline index                                                                                                                  | `snapshot/deadlines.rs`, over `ace-core`'s `deadlines.rs` (the `DeadlineIndex` port)                                |
| `persistence.ts:240`–`:262` (`header`)                                                                                                                                                                                                                                | the `thread_state.state` JSON                                                                                                       | `snapshot/header.rs`                                                                                                |
| `snapshot.ts` (`recordSchemas` `:72`, `snapshot` `:87`, `decodeSnapshot` `:146`)                                                                                                                                                                                      | validate a stored header and each record without stripping                                                                          | `snapshot/decode.rs`                                                                                                |
| `schema-version.ts` (`:6`, `requireEngineVersion` `:15`, `requireSnapshotVersion` `:24`, `requireEngineColumns` `:34`)                                                                                                                                                | version 9, refusals with `IncompatibleDataError`                                                                                    | `snapshot/version.rs` (`requireSnapshotVersion` only; the database checks run in the TypeScript opener)             |
| `item-metadata.ts` (`keepsItemMetadata` `:4`, `itemMetadata` `:9`, `appendTarget` `:22`, `unchangedByTextAppend` `:37`)                                                                                                                                               | metadata copies of text items                                                                                                       | `snapshot/metadata.rs`                                                                                              |
| `records.ts` (`Records` `:22`–`:291`)                                                                                                                                                                                                                                 | one lazy dictionary per section, its transaction overlay, persist                                                                   | `records/mod.rs` (`Records`), `records/overlay.rs`, `records/persist.rs`                                            |
| `record-cache.ts` (`RecordBudget` `:14`, `RecordSection` `:50`, `uncachedSection` `:59`, `RecordTransaction` `:66`)                                                                                                                                                   | the shared LRU budget                                                                                                               | `records/budget.rs`                                                                                                 |
| `append.ts` (`Append` `:5`, `restoreAppend` `:11`)                                                                                                                                                                                                                    | text-append patches                                                                                                                 | `records/append.rs`                                                                                                 |
| `migrations.ts` (`migrateEngine` `:9`, `intentColumns` `:74`)                                                                                                                                                                                                         | fresh schema or refusal                                                                                                             | stays TypeScript (Migrations)                                                                                       |
| `store-generations.ts` (`maxStoreGeneration` `:14`, `get` `:28`, `advance` `:35`)                                                                                                                                                                                     | per-thread provider store generation; the table is created by the opener (`TransitionState` builds it, `transition-state.ts:62`)    | `repository/generations.rs`                                                                                         |
| `execution-provenance.ts` (`captureExecutionSources` `:5`)                                                                                                                                                                                                            | stamps `executionSource` on run starts and items                                                                                    | `repository/provenance.rs`                                                                                          |
| `provider-facts.ts` (`FactPorts` `:18`, `foldProviderFacts` `:32`–`:328`)                                                                                                                                                                                             | the fold inside the repository transaction: corrections, `FactBatch`, admission and acknowledgement, the queue updates, then `save` | `repository/fold.rs` (the frame and the admission block `:233`–`:303`), calling collaborators for the rest (step 7) |

Binding: `native/daemon/crates/ace-daemon-node/src/engine/repository.rs` (a new
`#[napi] impl NativeEngine` block for `hasState`, `retainsAttachment` and `readRawBlob`, the
facade members E5.1's table gives E5.3) and `engine/probe_repository.rs` (probe hooks). Shell:
`apps/daemon/src/native-engine/{repository,records,snapshot}.ts` (E0 stubs) and
`native-engine/open.ts` (new: the opener).

## Steps

### 1. The opener (`native-engine/open.ts`)

Needs the prerequisite fix on main. After it, the TypeScript repository's constructors do schema
setup only, so the opener is O(1) in history on an existing home.

The native facade's constructor, before it builds the Rust engine, constructs
`new EngineRepository(store, ids, capacity, commandId, aceToolAction, clock.now)`
(`repository.ts:104`) and drops it. That runs the schema setup of `repository.ts:115`–`:171` in
today's order: `initializeThreadCleanup`, `AceInputs`, `migrateEngine`, `indexEngineRecords`,
`AttachmentCorrelations`, `indexTitleInputs`, the `engine_entity_ids` index,
`initializeSessions`, `ProviderRecovery`, `SteerNotes`, `QueueStore`, the `engine_queue_recovery`
index, `IntentStore`, `InputJournal`, `InteractionLedger`, `TransitionState` (with
`StoreGenerations`), `TransitionReadiness`'s table, `DELETE FROM engine_slots` (bounded by the
slot capacity, 64), `thread_ownership`, `engine_open_fills`. A refusal (`IncompatibleDataError`
from `requireEngineVersion` or `requireEngineColumns`) is thrown from the facade's constructor at
the point the TypeScript throws it. The opener never starts the TypeScript fill driver: that
belongs to the TypeScript `Engine`, which the native path never builds; the Rust engine runs the
ported fills (prerequisite, last paragraph).

- Rust's `Repo::open` runs no statement and prepares nothing (statements are cached on first
  use).
- A later item whose TypeScript constructor has its own open work (for example
  `ContextMeters(store, …)`, `index.ts:320`) adds that constructor to this file in the TypeScript
  engine's order, and checks it does no data work at open; if it does, that is another fix on main
  first. The file's doc comment says so.
- Proof that open stays O(1): the opener and `Repo::open` timed on a cold clone of a large home,
  switch off and on (Proof).

### 2. The record budget (`records/budget.rs`)

Port `RecordBudget` (`record-cache.ts:14`–`:47`) and `BoundedCache`
(`provider-kit/src/bounded-cache.ts`) as one type. One budget per repository, shared by every
resident snapshot, exactly as the TypeScript shares `recordBudget` (`repository.ts:93`):

- At most **8192 entries** and **8,388,608 weighted bytes**. An entry's weight is **4 × the
  UTF-8 byte length** of its JSON (`record-cache.ts:34`, "charge decoded strings as well"). A
  string's byte length is what `Buffer.byteLength` gives: a lone surrogate counts 3 bytes.
- LRU: a `get` hit and a `set` both move the entry to newest. A `set` whose weight alone exceeds
  the byte budget keeps nothing and returns false, and the section does not record the key.
  Eviction drops oldest entries until both limits hold, and each eviction removes the key from its
  owning section's resident-key set (the `onEvict` callback). An explicit `delete` does not count
  as an eviction.
- A **section** (`section()`, `:23`) is a serial prefix plus the set of its keys still resident.
  It holds no other bookkeeping, so a section that cycles 200,000 keys through a full budget keeps
  only the keys still cached (`record-budget.process`).
- `clear()` drops that section's resident entries. A **released** section is uncached
  (`uncachedSection`, `:59`): `get` misses, `set` and `delete` do nothing.

In Rust a cached value is the decoded record plus its JSON text and byte count
(`CachedRecord`, `:2`). Use `IndexMap` with `shift_remove` for the LRU order (rule 8), never
`HashMap` iteration order.

### 3. The lazy section (`ace-core`, needs a core reviewer)

`ace-core` today folds over `IndexMap` sections read by borrow (`emit.rs:22`,
`get(&IndexMap) -> Option<&V>`). The record sections become `Section<T>`
(`ace-core/src/section.rs`): `agents`, `runs`, `items`, `interactions`, `tasks`,
`interactionHistory`, `taskHistory`, `itemLinks` and the eight `indexes` maps.

**Which sections the core enumerates.** `agents` (9 sites) and four index sections:
`liveTools`, `pendingInteractions`, `runningTasks` and `openText` (`.keys()` in
`live_tool_keys`, `pending_interaction_keys`, `running_task_keys`, `open_text_keys`,
`indexes.rs:128`–`:179`). Every other section is reached only by key. The builder re-greps before
writing and lists the enumerated sections in `section.rs`'s doc comment.

**Ownership: one cache, one overlay.** A section holds no long-lived values of its own, so there is
no second resident map beside the shared 8192-entry / 8 MiB budget:

- The **budget** (step 2, in `ace-engine`) owns every cached record across transactions, as
  `Rc<T>` beside its JSON and byte count. Eviction drops the budget's `Rc`.
- The **overlay** (in `Section<T>`) holds what the current scope has read or written: a slot per
  key, `Read(Rc<T>)`, `Written(T)` or `Deleted`, plus the base JSON of each read (the TypeScript
  `originals`, `records.ts:31`). It is cleared at `committed()` and, for reads outside a
  transaction, at the end of that read scope (`Snapshot::end_untracked`, called by the repository
  when the `with_state` closure that read returns). So it holds at most what one batch or one read
  touched, which is what the TypeScript `touched` map holds (`records.ts:30`).
- A section with no source (the default, used by `@ace/core`'s facade, `ace-core-wasm` and every
  core test) holds every entry in a resident `IndexMap` and behaves exactly as today: same serde
  form, same key order. The E4 (a) files and the core vectors pass unchanged; run the core's tests
  and its facade tests with `ACE_CORE=native` before and after.

**The API the core uses.** Reads that can miss are fallible and take `&mut`, because a miss loads
into the overlay; reads after a load borrow from it:

```rust
pub trait RecordSource<T> {
    /// The budget, then SQLite. An owned handle: the budget keeps its own `Rc`.
    fn load(&self, key: &str) -> Result<Option<Rc<T>>, SourceError>;
    /// Stored keys in rowid order (the TypeScript `ownKeys` query, `records.ts:153`).
    fn keys(&self) -> Result<Vec<String>, SourceError>;
}
impl<T: Clone> Section<T> {
    pub fn load(&mut self, key: &str) -> Result<(), SourceError>;      // ensure in overlay
    pub fn load_keys(&mut self) -> Result<(), SourceError>;            // ensure the enumeration
    pub fn peek(&self, key: &str) -> Option<&T>;                       // overlay or eager map only
    pub fn get_mut(&mut self, key: &str) -> Result<Option<&mut T>, SourceError>; // Read -> Written, copy on write
    pub fn insert(&mut self, key: String, value: T);                   // Written
    pub fn remove(&mut self, key: &str) -> Result<Option<T>, SourceError>; // Deleted
    pub fn keys(&self) -> impl Iterator<Item = &str>;                  // after load_keys
    pub fn changes(&self) -> impl Iterator<Item = (&str, Change<'_, T>)>; // for persist
}
```

- The core's helpers change from `get(&IndexMap, key)` to `section.load(key)?` then
  `section.peek(key)`, so two values of one section can be held at once after loading both. A fold
  function that reads a section returns `Result<_, FoldError>`; `FoldError::Source(SourceError)`
  joins `ace-core/src/error.rs`. A `peek` of a key not loaded is a bug: it returns `None` in
  release and fails a `debug_assert` in tests.
- **Edits reach the overlay only through `get_mut`, `insert` and `remove`.** `get_mut` turns a
  `Read(Rc<T>)` slot into `Written(T)` by `Rc::unwrap_or_clone`, as the TypeScript treats a value
  read while tracking as possibly mutated in place (`records.ts:146`–`:150`). `changes()` yields
  every `Written` and `Deleted` slot with its base JSON; the engine's persist (step 4) writes a
  `Written` value only if its encoding differs from that base, so a value fetched for writing but
  left unchanged writes nothing, as today.
- Enumeration: `load_keys` calls `keys()` once per transaction and merges the overlay. Order is
  the TypeScript `ownKeys` result: stored keys in `rowid` order, then the overlay's additions, then
  **JavaScript object order** on top (`Object.keys(Object.fromEntries(...))`, `records.ts:171`):
  integer-like keys first in ascending numeric order, then the rest in insertion order. A test pins
  it with keys `"10"`, `"2"`, `"b"`, `"a"`.
- A load or keys failure surfaces from the fold as `FoldError::Source`; the engine maps it to the
  error the TypeScript throws there (`Invalid snapshot record`, `records.ts:16`, or the SQLite
  error). The core never sees SQL.
- Budget accounting stays the TypeScript's: an entry's weight is 4 × its JSON bytes; an `Rc` the
  overlay still holds after the budget evicted it lives until the overlay clears, bounded by one
  scope, as a TypeScript value held by `touched` is.

### 4. Records (`records/`)

Port `Records<T>` (`records.ts:22`–`:291`) behind `RecordSource<T>`, with the same state and the
same rules:

- **Reads** (`read`, `:118`): the append overlay (`appendValue`), then `touched`, then the
  budget, then SQLite: `SELECT value FROM engine_state_records WHERE thread_id=? AND section=? AND
key=?`, then every `engine_state_appends` patch for the key `ORDER BY id`, then the pending
  in-transaction `patches`. The byte count is the base JSON's bytes plus each patch's text bytes.
  The value is validated with the section's decoder **without stripping**: unknown fields stay
  (`parseRecord`, `:15`; rule 8). A hit moves to newest. While tracking, a read records the value
  in `touched` and its base JSON in `originals`, which survives LRU eviction (`:31`).
- **Writes** (`write`, `:101`) validate, decorate, cache with the **previous** JSON (so persist
  can tell a change), and mark the key `replaced` and `touched`. **Deletes** put `None` in
  `touched` and drop the cache entry.
- **Appends** (`append`, `:197`): skipped when the key was replaced, or when nothing is cached and
  the key is not the current append value. Inside a transaction, a patch with the same path joins
  the previous one while their combined text is at most **32,768 UTF-16 code units**
  (`previous.text.length + patch.text.length <= 32768`, `:209`; count UTF-16 units, not bytes or
  chars). Outside one, it is inserted at once. The cached entry's bytes grow by the patch's bytes.
- **`useAppendValue`** (`:185`) and its finish closure are an RAII guard in Rust; the finish
  rules (`:188`–`:195`) are unchanged.
- **Persist** (`:237`): pending patches of keys not replaced are inserted; each touched `None`
  deletes the key's appends then its record; each touched value is encoded and, if its JSON
  differs from `originals` (else the cached JSON) or it was replaced, its appends are deleted and
  the record upserted (`ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value`).
  Then the cache holds the new JSON. Appended-but-not-replaced keys are not rewritten.
- **Committed** (`:271`) clears every overlay and the enumeration. **Release** (`:178`) clears the
  section and makes it uncached; later reads go to SQLite.
- The agents section's decorator and encoder (`persistence.ts:65`–`:77`) move with it: an agent's
  `nativeRuns` live in their own section `nativeRuns:<agentKey>`, and the agent record stores
  `nativeRuns: {}` in their place. Section names are contract; list them in one `const` slice:
  `agents`, `items`, `itemMetadata`, `runs`, `interactions`, `tasks`, `interactionHistory`,
  `taskHistory`, `itemLinks`, `liveTools`, `openText`, `pendingInteractions`, `runningTasks`,
  `agentKeysById`, `childrenByParent`, `pendingSpawnLinks`, `pendingItemLinks`, `nativeRuns:*`.

Restore appends with `restoreAppend` (`append.ts:11`): descend the path, create missing objects
(the seed only at the last object step), fill arrays, refuse a non-string leaf with
`Invalid saved append target`. The `Append` patch JSON is `{path, text, seed?}` in that order.

### 5. The snapshot (`snapshot/`)

Port `Snapshot` (`persistence.ts:19`–`:296`):

- **Construction** wraps every section of a decoded state in a `Records` over the shared budget,
  plus the `itemMetadata` section, which starts empty (`:93`–`:104`). `openText` absent from an old
  header starts empty (`snapshot.ts:115`; `open-text-restart.process`).
- **The header** (`:240`) is the state's own JSON with each record section emptied and
  `engineSnapshot: 9`. Key order is that of `{...state, agents: {}, …, engineSnapshot}`: a spread
  then an override keeps the key where the state had it, and `engineSnapshot` goes last only if
  the state had none. A decoded header has one, so it keeps its place. Write it with
  `ace_json::ser`, from the state's own key order (the core keeps unknown header fields as raw
  data, which a home written by a newer build has).
- **Decode** (`snapshot.ts:146`): parse, check `engineSnapshot === 9` (else
  `IncompatibleDataError(location, "Unsupported engine snapshot format: expected 9",
"Quit ace, then start it with a fresh ACE_HOME.")`, `schema-version.ts:24`), then validate the
  header shape without stripping. `EngineError::Incompatible { message, recovery }` crosses to the
  facade, which throws `new IncompatibleDataError(store location, message, recovery)`.
  `skippableAtStartup` (`startup-skip.ts`) then sees the same class.
- **Item metadata** (`item-metadata.ts`, `persistence.ts:161`–`:211`): `prepare`, `remember`,
  `delta` and `streamItem` keep the streaming path proportional to the change, never to the
  transcript: a text item's metadata is the item with its text blanked, and a plain text append
  that changed nothing else leaves it as it is (`unchangedByTextAppend`).
- **Deadlines** (`:212`–`:239`): built lazily over `ace-core`'s deadline index; a pure-delta batch
  signals the agents it names, anything else rebuilds; a clock that went backwards (a rollback)
  rebuilds.
- **Lifecycle**: `begin` turns tracking on; `persist` persists every touched section (a section
  can register while another persists); `committed` clears; `release` is permanent, and a
  dictionary the snapshot opens after release is released as it is made (`own`, `:149`).

### 6. The repository (`repository/`)

`Repo` lives in `State.repo` (E5.1 step 4) and holds: the resident snapshots in LRU order
(`IndexMap<ThreadId, Rc<RefCell<Snapshot>>>`), each one's stored `seq`, the snapshot generation,
the budget, the `opening` and `retiring` sets, and the capacity (the engine limit
`maxActiveThreads`, 64, as `index.ts` passes it). It holds no port and no connection; functions
that need SQL take the `EngineStore` or a `Tx` (E5.1 step 8; E5.3 adds `Tx::conn()` and gives
`EngineStore` the connection, in E5.1's `lib.rs`, which is the one edit there).

- **`state(id)`** (`repository.ts:206`): with a live write pending for the thread, the resident
  snapshot's state, untouched. Else sync with the rollback generation (below), read
  `thread_state` (`state,seq`), drop the snapshot if the row is gone, rebuild it if the stored `seq`
  differs from the resident one's, move it to newest, trim. `requireState` throws
  `Missing engine state`.
- **`save(state, payloads, at)`** (`:294`), inside `EngineStore::atomic`: sync; reuse the resident
  snapshot only if it is the same snapshot (`Rc::ptr_eq`, the TypeScript's `snapshot.state !==
state`), else wrap the given state in a new one, which rewrites every record, as today; on a
  `run.started`, `item.created` or `item.updated` payload, capture execution sources (step 6a);
  `readiness.capture` (E5.9 collaborator); `retainChanges`; `writeEvents` (Decision 1); upsert
  `thread_state` with the header and `headSeq()`; `flush`; record the seq; retire, insert, trim.
- **`stream(id, facts, now)`** (`:363`): the same refusals, in order (empty, over 256 facts, any
  fact other than `item.delta` or `signal`, process exited, a clock behind `statusObservedAt` or
  `lastTransportSignalAt`, a deadline reached, an item without stream metadata, an unknown or
  unresponsive agent, over 512 KiB of fact bytes). Then `prepareLiveWrite(bytes)`, E5.2's
  `stream_facts`, and `bufferLiveWrite(id, events, now, token)` through the store's shell, whose
  `persist` and `committed` callbacks are binding entries keyed by `token` that run the snapshot's
  `readiness.capture`, `thread_state` upsert and `persist`, and `committed` plus the seq. They are
  synchronous entries inside the buffer's flush transaction, so they never run a task (E5.1
  step 3). Who owns the buffer and its flush is E5.2's; E5.3 owns only these callbacks.
- **`apply(id, facts, now, generation)`** (`:413`) and the fold (step 7). On any error the thread
  is evicted (unless a live write is pending), then the error rethrown.
- **Slots** (`:516`–`:543`): `reserve` counts `engine_slots` minus `retiring` against the
  capacity, asks the `reclaim` hook (E5.6) before refusing; `release` deletes the row and forgets
  the retiring mark.
- **Reads** (`:544`–`:672`, `:715`–`:756`): the same SQL at the same transaction boundary
  (Decision 3), the same results. `captureFrame` keeps the Cursor checks and the bounded frame
  JSON (`boundedJson`, ported or reached through E5.2's frame code, whichever E5.2 lands).

**6a. Execution provenance** (`execution-provenance.ts:5`): a root run's source is the thread's
selection with the native session id; a child's is its own provider and model, with the instance
only when the provider matches. Items take their run's source. Validate with the protocol's
`ExecutionSource` shape, as the TypeScript parses it.

**6b. Store generations** (`store-generations.ts`): `get` reads the row (0 when absent, a
non-negative integer else), `advance` upserts `get + 1` inside the caller's transaction.
`maxStoreGeneration` (64) is contract.

### 7. The fold's frame and its collaborators (`repository/fold.rs`, `repository/collaborators.rs`)

`foldProviderFacts` (`provider-facts.ts:32`) is the repository transaction around a fold. E5.3
ports its frame: `snapshot.begin`, the `FactBatch` over `ace-core` with the snapshot's deadline,
`coalesceFacts` (E5.2), the per-fact corrections, `batch.apply`, `batch.flush`, the failed-status
shaping (`:203`–`:225`), the admission and acknowledgement block (`:233`–`:303`) with the four
admission statements, the continuation and uncertain-queue updates (`:304`–`:316`), the retire
call, `updateDeadlines`, `save`, `observe`. Every step stays in the TypeScript's order.

Each call into a module another item owns goes through a trait in
`repository/collaborators.rs`, one trait per owner, default methods returning
`Err(EngineError::not_ported("<what>", "E5.<n>"))`:

| Trait           | Methods (the TypeScript call)                                                                                                                                                                                                                                                                                                                                                    | Owner |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `FrameFacts`    | `coalesce_facts` (`delta-batch`), `stream_facts`, `streamed_facts_bytes`, `cap_fact` (`raw`), `bounded_json`                                                                                                                                                                                                                                                                     | E5.2  |
| `InputFacts`    | `inputs.correlate`, `inputs.keyFor`, `aceInputs.attribute`, `pending.handedOver`, `pending.uncertainContinuation`, `pending.resolvingInteractions`, `pending.finishContinuation`, `pending.awaiting`, `queue.get`, `queue.set`, `queue.prune`, `queue.hasUncertain`, `bindConsumedInput`, `bindStartedRun`, `retireEndedTurnInputs`, `aceWaitFact`, `goalChange`, `rootRunStart` | E5.4  |
| `SessionFacts`  | `session(id)` (model, native id), `shapeProviderError`, `structuredError`                                                                                                                                                                                                                                                                                                        | E5.6  |
| `AccessFacts`   | `permissions.effective`, `interactions.obsolete`, `opened`, `closed`, `observe`, `attributeAceAction`                                                                                                                                                                                                                                                                            | E5.7  |
| `RecoveryFacts` | `resendingCode`, `resentNotice` (`cursor-attempt`)                                                                                                                                                                                                                                                                                                                               | E5.8  |
| `MoveFacts`     | `forkReplaySource`, `inheritedReplay`, `transitions.get`, `transitions.delivered`, `readiness.capture`, `readiness.refreshBlocked`, `readiness.agentsReady`, `readiness.acceptsPersonInput`, `quiescent`                                                                                                                                                                         | E5.9  |

`impl <Trait> for State {}` lines sit at the end of `collaborators.rs`. An owner implements its
methods in its own module and deletes its one empty `impl` line from `collaborators.rs` in the
same commit. That is the only edit an owner makes in E5.3's files. The thread title and goal
corrections (`:51`–`:76`) call the store through ports (`getThread`, `writeEvents`), not a
collaborator.

### 8. Rollback, live pins and the record cache

The TypeScript keeps no undo log for in-memory state. It drops what may be stale and reloads from
SQLite, and E5.3 does the same, with the generation kept **per snapshot** so a snapshot spared by
one sync is still checked later.

- **The generation.** The store bumps `rollbackGeneration()` (`store.ts:593`) on a top-level
  rollback, a nested rollback (`store.ts:624`, `:629`, through the native shell's `topRolledBack`
  and `nestedRolledBack`) and a failed history install (`:980`, outside the stack). Rust reads it
  through a synchronous port, `rollbackGeneration(): number` (a number, no JSON), at each point the
  TypeScript calls it: `state()` and `save()`.
- **Per-snapshot stamp.** Each resident snapshot records the generation it was last valid at. A
  sync drops and releases every resident snapshot **without a live pin** whose stamp is older than
  the current generation, and stamps the survivors it checked. A pinned snapshot is skipped and
  keeps its old stamp. (The TypeScript records one global `snapshotGeneration`, `repository.ts:204`,
  so a snapshot spared while pinned is never checked again; Rust must not copy that.)
- **A pin ends in exactly one of two ways**, and each settles the exact snapshot the pin was
  taken on (the `Rc` captured with the buffer token, never a lookup by thread id, since the map may
  hold a newer snapshot by then):
  - **Commit** (`native-writer/live.ts:196`, the buffer's `committed`): the snapshot's
    `committed()` runs, its stored `seq` becomes the commit's head seq, and its stamp becomes the
    current generation, since its rows now match its state. A pinned snapshot no longer resident
    (`Rc::ptr_eq` fails) is committed and then dropped and released.
  - **Discard** (quarantine, `store-stream.ts:276`–`:289`): the store first removes the pin
    (`buffer.discard`, `live.ts:202`), then notifies its quarantine listeners
    (`store-stream.ts:272`, `store.ts:784`). The engine's listener first **evicts and releases that
    snapshot whether or not an actor exists**, then calls the actor's `quarantine` if there is one
    (`engine/index.ts:366`–`:369`, `actor.ts:268`). Keep that order: pin removed, snapshot evicted,
    actor told. Its overlay holds deltas that were never stored, at the same `seq` as the stored row,
    so the `seq` check alone would keep it. (Today the TypeScript evicts only through the actor,
    `actor.ts:276`; the prerequisite PR adds `repo.evict(id)` before the actor call in the engine's
    listener, `engine/index.ts:367`, with the test "a quarantined thread with no actor reloads its
    stored state".)
- **Dropping is releasing.** A dropped snapshot's sections clear their budget entries and turn
  uncached (step 2). A task still holding its `Rc` keeps working on it and its reads go to SQLite,
  as a state kept past release does today (`snapshot-release.process`).
- **Overlays.** `touched`, `patches`, `originals`, `replaced` and `appended` clear only on
  `committed()`. After a rollback, the snapshot holding them is dropped at the next `state` or
  `save`, so they are never persisted. That includes a savepoint rollback caught inside a
  still-open outer transaction: the nested rollback bumps the generation, and the next `save` in
  the same outer transaction reloads first (`snapshot-rollback.process:123`).
- **What never happens:** a rolled-back or discarded value kept under a resident snapshot, or a
  snapshot reused across a rollback with an unchanged `seq` (`snapshot-rollback.process:98`: a
  nested save whose event sequence did not change).

**Borrows across ports and callbacks** (E5.1 re-entrancy rules, `e5-1-brief.md:908`–`:913`). No
`with_state` borrow and no `RefCell` borrow of a `Snapshot` is held across a port call or across
`EngineStore::atomic` (whose `open` can flush the live buffer and run this engine's `persist` and
`committed` callbacks). `save` is therefore: `atomic(|tx| { with_state(pre: provenance,
readiness, retainChanges, SQL on tx.conn()) ; port writeEvents ; port headSeq ; with_state(post:
thread_state upsert, flush, stamp, residency) })`, in the TypeScript's order, with every borrow
dropped before each port. The `persist`, `committed` and quarantine callbacks take their own
borrows. A test re-enters from inside `writeEvents` (a store write hook that reads the thread's
state) and from a flush triggered by `open`, and expects no `Reentrant` error.

### 9. The startup candidate scan (`repository/candidates.rs`)

E5.1's `ready()` calls `repository::recovery_candidates` in a loop. E5.3 replaces the stub and
changes its contract: it takes the `EngineStore` and returns `Step { threads: Vec<ThreadId>, done:
bool }`; the loop ends on `done`, **never on an empty `threads`** (a page can scan 256 rows, match
none, and have candidates after it). The one-line change at E5.1's two call sites in `lib.rs`
(`ready_steps`) goes with it.

- **The set** is `repository.ts:259`–`:266`'s union, with its dedup: threads whose
  `json_extract(status,'$.state')` is not `new`, `done` or `failed`; threads with an intent
  `pending`, `queued` or `running`, or `awaiting=1`, or `uncertain=1`; threads with an
  `engine_queue` row with a continuation, a trigger, `limited=1` or `paused=1`; each only if it has
  a `thread_state` row, and only if `thread_id > ''` (the first page's `after` is `''`, `:256`).
- **The order** is the TypeScript's: ascending `thread_id` under SQLite's `BINARY` collation, each
  candidate once, recovered before the next ones are looked for (the TypeScript recovers a page of
  64 before querying the next, so rows a recovery writes for a later thread are seen). E5.3 keeps
  that without a final sort, by reading every source **in `thread_id` order** and merging:
  - `threads` by its primary key `id` (cursor: the last `id` scanned);
  - `intents` by the index `intents_pending(thread_id, status, id)`, cursor the last
    `(thread_id, status, id)` scanned, `WHERE (thread_id, status, id) > (?, ?, ?) ORDER BY
thread_id, status, id LIMIT 256` (row-value comparison), evaluating the predicate per row;
  - `engine_queue` by its primary key `thread_id`.

  Each source's page is at most **256 rows scanned**, and its cursor advances to the **last row
  scanned, matched or not**. A source whose page came back short is exhausted. The watermark is
  the smallest last-scanned `thread_id` over the sources not yet exhausted (+∞ when all are). Held
  matches with `thread_id <= watermark` and greater than the last emitted id are emitted in order,
  each checked against `thread_state` by primary key; matches above the watermark are held (at most
  3 × 256). A match at or below the last emitted id is a duplicate and dropped. So every emitted id
  is final and in order, and nothing is sorted after the fact.

- **Pages, exactly as the TypeScript pages.** The TypeScript takes a page of up to **64**
  candidates (`repository.ts:265`, `LIMIT 64` over the union ordered by `thread_id`), recovers
  each, then queries the next page from `thread_id > after`, the last recovered id (`:256`,
  `:272`). E5.3 builds the same pages:
  1. **Accumulate.** Scan steps (one pump step each, one `EngineStore::atomic` each, one page of at
     most 256 scanned rows from each non-exhausted source whose last-scanned id is the watermark)
     add emittable matches, in order, to the page being built. No recovery runs while a page is
     being built, and commands are refused (`engine_starting`), so nothing behind the cursors
     changes between these steps.
  2. **Close the page** when it holds 64 candidates (then the 65th and later matches are not
     kept), or when every source is exhausted and nothing is held. A partial page is closed only
     at exhaustion, never because a step found fewer.
  3. **Recover the page**, one pump step per thread (E5.8).
  4. **Re-query from the last recovered id.** Discard every source cursor and held match, and start
     the next page with all three sources at `thread_id > last recovered id`, as the TypeScript's
     next query does. A thread a recovery made eligible after a cursor had scanned past it is found
     if its id is above the last recovered one, exactly when the TypeScript finds it.

  **`done` only after an empty page.** A page closed at exhaustion that holds candidates is not
  the end: its recoveries may have made a later thread eligible, so after recovering it the scan
  re-queries from its last recovered id like any other page. The scan is done only when a page,
  built from a fresh re-query, comes back with no candidates at all, as the TypeScript returns
  only when `ids.length` is 0 (`repository.ts:269`). So the pages, their boundaries and the
  recovered set are the TypeScript's.

- This corrects ADR 0223 §5's "`threads` by rowid, `intents` by `id`": paging those by rowid
  would need a final sort to recover in `thread_id` order.
- **Unreadable state** (`:270`–`:277`): a candidate whose state fails to decode with an error
  `skippableAtStartup` accepts is reported and skipped; anything else fails readiness, as today.
- Tests (beside it, new behaviour, and the commit says so): "a page that matches nothing does not
  end the scan" (300 idle threads, then a working one); "candidates found by different sources
  come out once, in thread_id order" (one thread in all three); "a thread an earlier recovery made
  a candidate is recovered in the same pass"; "a thread a recovery makes eligible behind an advanced cursor is recovered in the next page" (64
  working threads `t00`…`t63`, then `u` idle; building the first page scans past `u` in every
  source; the probe's recovery of `t00` inserts a pending intent for `u`; `u` is recovered in the
  second page, because the re-query starts at `t63`, not at the cursors); "pages close at 64 candidates as the TypeScript's do" (130 candidates spread over 2,000
  threads: pages of 64, 64, 2, and a recovery in the first page that makes a thread eligible below
  the first page's last id is not recovered, as in the TypeScript, while one above it is); "a
  partial last page whose recovery makes a later thread eligible is followed by another page" (3
  working threads `a`, `b`, `c` and an idle `z` after them; the first page is `a`, `b`, `c`, closed
  at exhaustion; the probe's recovery of `c` inserts a pending intent for `z`; `z` is recovered in a
  second page, and only the third, empty page ends the scan); "an empty thread id is never a
  candidate".
- Delete the probe's `emptyCandidates` stub and `State.probe_empty_candidates` (E5.1 step 12).
- `states()` (`repository.ts:283`–`:292`) is not ported: no repository code calls it, and it reads
  every `thread_state` id at once.

## Migrations: stay TypeScript (decided)

`migrateEngine` (`migrations.ts:9`) creates a fresh schema or refuses an old one; it never
upgrades. Around it, about twenty steps in more than a dozen modules create their tables and
indexes at open (step 1). Options:

- **Stay TypeScript (recommended).** The opener runs the same constructors in the same order, so
  the DDL has one source, and a home made by either backend is made by the same statements.
  The cost is one TypeScript object graph built and dropped at boot, with no history-sized work once the
  prerequisite fix has merged (before it, the constructors' data work is the defect that fix
  removes).
  The open statements move to Rust verbatim (same text, same order) when the TypeScript engine is
  deleted, one release after default-on (ADR 0223 §8).
- **Move now.** Rust would hold a second copy of every one of those statements while the
  TypeScript files that hold them stay live until deletion, and a drift between them (one column or one
  partial-index predicate) would make a native-created home refuse to open with the switch off,
  breaking constraint 2. It would also put E5.3 in files that E5.4 to E5.9 own.

The Rust side checks only the per-row snapshot version (`requireSnapshotVersion`), which runs on
every decode, not at open.

## What "Rust commits publish through the JS shell" costs

E5.1 decision 6 left this to E5.3. `writeEvents` stays (owner, 2026-11-24): the shell's shared
context records the store's events once (`store.ts:1175`–`:1185`, `recordEvents`), truncates them
on a rollback (`native-writer/transaction.ts:221`–`:230`), and publishes them at the outer commit
(`:269`–`:278`), whoever opened the transaction. One engine step commit (a `save` from a fold) with
the switch on crosses napi this many times:

| Crossing                                                                                                                                                                   | Count per commit            | Data                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| shell `open` (flush, context, `stack.begin`)                                                                                                                               | 1 call                      | none                                                        |
| `rollbackGeneration`, `hasLiveWrite`, `headSeq`                                                                                                                            | 1 each per `state`/`save`   | numbers, booleans                                           |
| `writeEvents(threadId, payloadsJson, at)`: Rust encodes, JS `JSON.parse`s, the store's writer runs, and with `ACE_STORE_WRITER` it crosses back into `ace-store` per event | 1 call + 1 per event inside | the payloads twice (Rust → JSON → JS → the store's encoder) |
| shell `close` (`succeed`, `Finish` JSON, settle, publish, `releaseWakes`)                                                                                                  | 1 call                      | the `Finish` JSON                                           |

The engine's own rows (`thread_state`, records, appends, admission) cross nothing. **Two gates,
both "no worse than switch-off"**: `engineCommit` p50 and p95 (Benches), and, from E5.8 when sends
exist, `bench/head-of-line.ts`'s `stopAck` and `sendReceipt` p50, p99 and max under the `live` bulk
(porting guide, "For every E5 item"). If either is worse and the payload round trip is the cause,
report it with the split; the fix is the store's event-writer orchestration moving to Rust (ADR
0226), not a second writer in the engine (Decision 1).

## Proof

Every (a) and (b) file is run alone, switch off and on (rule 3), with `ACE_STORE=native`,
`ACE_STORE_WRITER=…,transactions` and a fresh `ACE_ENGINE_EVIDENCE` for the switch-on run, which
must be non-empty afterwards. With the switch off every file passes unchanged: E5.3 edits no
TypeScript engine module (the prerequisite PR on main does, and has its own proof).

**(a) files, the storage row and E5.3's own** (behaviour.md §19). Each checks its row against the
file and amends E5.1's unblocked table in the PR.

| File (`apps/daemon/src/engine/`)                                                                                                                                                                                             | What it guards here                                            | Native green at                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `records-write-budget.process` (3 tests)                                                                                                                                                                                     | bounded transcript writes with hundreds of open approvals      | E5.6 (opens a scripted session through the harness)                                       |
| `schema-compatibility.process` (`:104`)                                                                                                                                                                                      | unversioned engine data refused, not initialised over          | E5.6 (seeds through a session); the refusal itself is the opener's, so it holds from E5.3 |
| `startup-quarantine.process` (`:35`, `:58`)                                                                                                                                                                                  | an unreadable thread skipped at startup while the rest recover | E5.8 (restart)                                                                            |
| `cold-state.process` (3 tests)                                                                                                                                                                                               | held queues and continuations after restart                    | E5.8                                                                                      |
| `storage-behaviour.process`, `item-metadata.process`, `live-write-buffer.process`, `live-write-quarantine.process`, `long-thread.process`, `maintenance.process`, `resource-limits.process`, `audit-cursor-recovery.process` | the rest of the storage row                                    | E5.6 or later, each to be checked                                                         |

So no (a) file of E5.3 is green end to end with the switch on when E5.3 lands. That is expected
(E5.1's table): every one seeds through a session. E5.3's native proof is the seam, the moved
cases and the home tests below, and each (a) file is re-run switch-on by the item that unblocks
it.

**(b) cases to move** into `#[cfg(test)]` modules beside the Rust that replaces them, same inputs
and expectations, none added or dropped (rule 4). Each runs over a temp `ace-store` database with
the opener's schema, which the test creates by running the fresh-home DDL from a fixture file the
test reads. Generate that file once from a TypeScript-opened home with
`sqlite3 home.sqlite .schema`, commit it under `ace-engine/tests/fixtures/`, and say so in the
commit: it is the schema, not a behaviour vector.

| TypeScript test                                       | Cases                                                                                                                                                                 | Rust home                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `item-metadata.test.ts:50`                            | plain text appends leave metadata unchanged                                                                                                                           | `snapshot/metadata.rs`                |
| `audit-record-cache.process.test.ts:24`, `:42`        | sections share one bounded cache and evicted records reload; appended text counts against the budget and survives eviction and replacement                            | `records/budget.rs`, `records/mod.rs` |
| `record-budget.process.test.ts:6`                     | a long-lived section keeps no bookkeeping for evicted keys (200,000 keys, another section's 64 entries filling the budget)                                            | `records/budget.rs`                   |
| `snapshot-retention.process.test.ts:6`                | a dropped snapshot is freed, not kept in the cache (1,500 reloads)                                                                                                    | `repository/residency.rs`             |
| `open-text-restart.process.test.ts:61`, `:72`         | a thought streaming at restart closes when its turn ends; a header saved before `openText` loads                                                                      | `snapshot/mod.rs`                     |
| `snapshot-release.process.test.ts:16`                 | a state kept past its snapshot reads native runs it opens later as currently stored                                                                                   | `repository/residency.rs`             |
| `snapshot-rollback.process.test.ts:72`, `:98`, `:123` | a rejected save restores header and message; an outer rollback discards a nested save with an unchanged seq; a caught savepoint rollback reloads before the next save | `repository/save.rs`                  |

The two memory tests measure heap growth in a child (`retainedIncrease`). Rust has no garbage to
measure, so the moved case asserts what the byte figure stood for, on the same inputs: after the
run, the churned section's resident-key set has 0 entries and the budget holds at most 8192
entries (`record-budget`); after 1,500 drops, no released snapshot has an entry in the budget
(`snapshot-retention`). The commit says the expectation changed form and why.

**Seam tests** (`native-engine/persistence.test.ts`, E5.1 step 12, wrapped in
`describe.runIf(engineBackend() === "native")`; each names the (a) test that will replace it and is
deleted when that file first passes switch-on). Persistence is asserted on the **engine's own
rows**, read with plain SQL from the test, never through `store.snapshotThread`: that reads the
status and payload projections (`thread-reads.ts:165`–`:188`), which the store writes, so it would
pass with a broken header, records or appends.

- "the engine constructs, becomes ready, flushes and closes on a fresh home and on a seeded one,
  with one evidence line" (the smoke; no probe stub left);
- "a folded batch stores the expected engine rows": after a fixed batch (an agent seen, a turn
  started, a message item, deltas past 32,768 UTF-16 units, a tool call, a turn ended), the test
  reads `thread_state.state`, every `engine_state_records` row of the thread (`section, key,
value`, ordered by `rowid`) and every `engine_state_appends` row (`section, key, patch`, by
  `id`), and compares them with literal expected text in the test (header key order, record JSON,
  the coalesced patches). Then it **reopens them through the engine**: a fresh native engine on the
  same home folds one more delta and one more turn, and the test asserts the resulting rows again
  (the append continues the stored text; the turn ends the stored run);
- "a rolled-back fold leaves no record in the budget, its rows are unchanged, and the next fold
  reloads from SQLite";
- "a quarantined thread with no actor reloads its stored state" (step 8);
- "startup recovery over 600 candidate threads with 300 non-candidates between them takes several
  scan steps, the event loop runs between them, and `ready()` resolves after the last" (a
  `setImmediate` counter advances between steps).

The fold seam tests need the collaborators. The probe adds, under `engine-probe` only,
`probe.passThroughCollaborators()`: unported collaborator calls return the fact unchanged or no
rows, so a fold of plain item and turn facts runs before E5.4 to E5.9 land. It is scaffolding (the
owner accepted it, 2026-11-24), and the last owner to land deletes it.

**Home tests** (`native-engine/persistence-home.process.test.ts`, the real edge is a second
process). Both assert the engine rows by SQL as above, then reopen through the other engine:

- **TypeScript-written, native-read.** `engineSeam({ seedWithTypeScript })` runs a child with the
  switch off that creates threads through the TypeScript engine with a scripted adapter (one
  working, one done, one with an unreadable header, one with appended text past 32,768 units),
  then exits. The test checks the rows the child wrote against literals, then opens the native
  engine: the candidate set, the skipped thread's report, `hasState`, and one more fold per thread,
  whose rows are asserted.
- **Native-written, TypeScript-read.** The seam folds the same batches natively and the test
  checks the rows; then a child with the switch off opens `new Engine`, awaits `ready()`, applies
  one more scripted frame per thread and exits; the test asserts the rows the TypeScript wrote on
  top.

**Cross-mode run.** The E5 list (ADR 0223 §8) needs restart, so its first run is E5.8's
(E5.1 brief, Benches). E5.3 runs `scripts/native-cross.ts ACE_ENGINE` on each file of the list
only to record which fail as "no restart" and which fail at an unported step, and puts that list in
the PR. The home tests above are E5.3's rollback proof until then.

**Open time.** On an APFS clone (`cp -c`) of a large home with a cold cache, never with a daemon
on the clone (never-run-daemon rule), time the opener and `Repo::open`, switch off and on, and the
candidate scan (steps, longest step) and each fill (steps, longest step, total). With the
prerequisite merged, open must not grow with the home's size; the PR shows two homes of different
size opening in the same time.

## Benches

Switch off and on, same machine, figures in the PR:

- **`bench/sqlite-store.ts --split`.** Add an `engineCommit` figure: N fold-and-save commits of a
  fixed batch (one `item.upsert`, ten `item.delta`, one `turn.ended`) on one thread, through
  `EngineRepository.apply` with the switch off and through the probe's fold with it on (the on
  figure needs the `engine-probe` build, and the bench says so). **The fold work must be
  equivalent on both sides.** The probe's pass-through collaborators do nothing, so the batch is
  chosen so the TypeScript collaborators do nothing either: a thread with no inputs, intents,
  interactions, queue continuation or transition, and facts that are none of `input.consumed`,
  `goal.updated`, a title notice, `interaction.*` or a root `turn.started` with a queued trigger.
  The bench asserts it, by checking after the off run that no `engine_inputs`,
  `engine_interaction_requests` or `intents` row exists for the thread. Report p50, p95 and events
  per commit. When E5.4 to E5.9 have landed, the on figure is re-run without the probe on the
  same batch and replaces the probe figure. It extends an existing bench; no new file.
- **`bench/stream-history.ts`.** It folds through `@ace/core` and builds no `Engine`, so it
  measures the core's record work, not persistence. Run it with `ACE_CORE` off and native before
  and after the `Section` change (step 3): same `records`, timing within noise.
- **`bench/scripted.ts`.** It drives the engine through scripted sessions, which reach the native
  engine only through `JsSession` (E5.6). Record the switch-off baseline now; the switch-on figure
  is E5.6's.
- **`bench/head-of-line.ts`**: the second gate on the shell crossing (above), first runnable with
  the switch on at E5.8. E5.3 records nothing new for it.

## Files (all yours; nothing else)

- `ace-engine/src/{repository,snapshot,records}.rs` and their directories as the module map lists,
  including `repository/fills/` (the ported fills).
- `ace-engine/src/lib.rs`: `Tx::conn()`, the connection on `EngineStore`, the candidate scan's
  call sites and `Step` loop, the fill driver's start and stop, and the removal of
  `probe_empty_candidates`. Nothing else.
- `ace-core/src/section.rs`, `error.rs` (`FoldError::Source`), the `ThreadState` field types and
  the core helpers' move from `get` to `load` and `peek` (core reviewer, step 3).
- `ace-store/src/stmt_cache.rs`: a `run(conn, sql, params) -> (changes, last_insert_rowid)`
  beside `all_rows` and `get_row` (store reviewer). The engine's writes use it.
- `ace-daemon-node/src/engine/{repository,probe_repository}.rs`, and `mod` lines for them in
  `engine/mod.rs`; the new ports (`writeEvents`, `rollbackGeneration`, `bufferLiveWrite`'s token
  callbacks, the quarantine subscription) in `engine/ports.rs` and `native-engine/ports.ts`.
- `apps/daemon/src/native-engine/{repository,records,snapshot,open}.ts`, the probe methods and the
  stub removal in `testing.ts`, `persistence.test.ts`, `persistence-home.process.test.ts`.
- `apps/daemon/bench/sqlite-store.ts` (`engineCommit`).
- `ace-engine/tests/fixtures/engine-schema.sql`.

## Must not

- Start before the prerequisite PR has merged to main and been merged into this branch.
- Write `events`, `threads`, `items` or `payloads` rows, or any store table, from engine SQL.
- Add, drop or change a table, column, index, section name or JSON field; bump
  `engineSchemaVersion`.
- Do data work at open, or create an index there, in either backend.
- End the startup scan on an empty step, sort the candidates after collecting them, or recover a
  thread inside a scan step.
- Keep an undo log instead of the per-snapshot generation rule, reuse a snapshot across a rollback,
  or keep a discarded live pin's snapshot resident.
- Hold a `with_state` or `Snapshot` borrow across a port, a callback or `EngineStore::atomic`.
- Port `states()`.
- Edit a TypeScript engine module, or another E5 item's Rust files beyond deleting a line
  `collaborators.rs` names.
- Fall back to the TypeScript engine, or no-op an unported collaborator outside the probe.

## Reviewer checks

- Every SQL string in `ace-engine` is the TypeScript's text, with its source line in a comment, and
  sits at the same transaction boundary (Decision 3).
- The budget's limits, weights and eviction callback match `record-cache.ts` and
  `bounded-cache.ts`; byte counts are UTF-8 with lone surrogates as 3; patch coalescing counts
  UTF-16 units.
- `Section<T>` holds no values between scopes; its overlay clears at `committed()` and at the end
  of each untracked read; the five enumerated sections are listed and match a fresh grep.
- Header key order: spread-then-override, `engineSnapshot` in place; section enumeration in
  JavaScript key order.
- Sync drops every unpinned snapshot with an older stamp; a pinned one keeps its stamp until its
  own commit; discard evicts before the actor is told.
- The candidate scan: same predicates and dedup as `repository.ts:259`–`:266`, `thread_id > ''`,
  cursors advanced by the last scanned row, emission only at or below the watermark, `done` ends
  the loop, and each step is one pump step.
- The opener constructs the TypeScript repository, which does schema setup only; `Repo::open` runs
  no statement; the fills run as pump tasks with the main PR's SQL and cursors.
- Seam and home tests assert engine rows by SQL and reopen them through the engine.
- `cargo test -p ace-engine`, `-p ace-core`, `-p ace-store`, `check:daemon-native`, and every file
  above alone, off and on.

## Owner decisions (2026-11-24, after review by gpt-6.2-sol)

1. **The lazy section in `ace-core`**: accepted, with the API and ownership of step 3 (one shared
   budget, a per-scope overlay, fallible `&mut` reads, edits only through `get_mut`, `insert` and
   `remove`).
2. **Probe-only pass-through collaborators**: accepted, and `engineCommit` must measure equivalent
   fold work on both sides (Benches).
3. **The rollback generation stays a synchronous port**, and no state or snapshot borrow is held
   across a port or callback (step 8).
4. **The opener's data work is fixed on main first**: "Prerequisite fix on main". E5.3 ports the
   bounded version.
5. **`writeEvents` stays**, gated on `engineCommit` and on head-of-line latency.
6. **`states()` is omitted.**

## Open questions

1. **Indexes a supported home can lack** (prerequisite table, last row). Recommended: the
   prerequisite PR lists them with the release that added each; any that a schema-14 home can lack
   is filed as its own issue rather than built at open or by a fill without the owner's approval of
   the cost.
2. **`queue-attachments` per boot or once.** Recommended: durable, once per home, as specified,
   since `track` keeps rows current while the daemon runs. If the PR finds a path that changes a
   live intent's attachments without `track`, that path calls `track`, and the fill stays once.
