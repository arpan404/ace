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
4. **Migrations stay TypeScript** until the TypeScript engine is deleted. Recommendation and
   reasons are in "Migrations" below.
5. **The record dictionaries are lazy in Rust too.** The Rust core's `ThreadState` holds plain
   `IndexMap`s (`ace-core/src/state.rs:226`–`:230`). Loading every record of a thread into them
   would make a thread's first touch cost its whole history and break the record budget, so the
   sections become a lazy, budgeted map type in `ace-core` (step 3). This is the one change outside
   `ace-engine` that needs a core reviewer.
6. **Calls into modules other items own go through E5.3's collaborator traits** (step 7). Until an
   item lands, each trait method fails with `NotPorted` naming that item. E5.3 never edits another
   E5 item's files.

## Module map

Rust paths are in `native/daemon/crates/ace-engine/src/`. Split each module into the files
listed, all under 400 lines.

| TypeScript (`apps/daemon/src/engine/`)                                                                                                                                                                                                                                | What it does                                                                                                                        | Rust                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `repository.ts:64`–`:172` (`EngineRepository`, constructor)                                                                                                                                                                                                           | open sequence, statements, the snapshot map                                                                                         | `repository/mod.rs` (`Repo`), `repository/open.rs`; the DDL itself stays TypeScript (Migrations)                    |
| `repository.ts:173`–`:199` (`nextCommandId`, `acknowledgeCommand`, `beginSessionOpen`, `resetAdmission`, `finishSessionOpen`, `recoveryAcknowledgement`)                                                                                                              | command ids, admission rows, the opening set                                                                                        | `repository/admission.rs`                                                                                           |
| `repository.ts:200`–`:254`, `:294`–`:355` (`syncSnapshots`, `state`, `deadline`, `setSilenceMs`, `evict`, `requireState`, `save`, `trim`, `drop`, `retire`)                                                                                                           | the resident-snapshot cache, rollback sync, save                                                                                    | `repository/residency.rs`, `repository/save.rs`                                                                     |
| `repository.ts:255`–`:293` (`recoveryStates`, `states`)                                                                                                                                                                                                               | startup candidates, every state                                                                                                     | `repository/candidates.rs` (fills E5.1's `recovery_candidates`)                                                     |
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

The native facade's constructor, before it builds the Rust engine, runs the TypeScript
repository's open sequence exactly: it constructs `new EngineRepository(store, ids, capacity,
commandId, aceToolAction, clock.now)` (`repository.ts:104`) and drops it. That runs every
statement of `repository.ts:115`–`:171` in today's order: `initializeThreadCleanup`, `AceInputs`,
`migrateEngine`, `indexEngineRecords`, `migrateEmptyCursorThreads`, `AttachmentCorrelations`,
`indexTitleInputs`, the `engine_entity_ids` index, `initializeSessions`, `ProviderRecovery`, the
`engine_provider_frames` statement, `SteerNotes`, `QueueStore`, the `engine_queue_recovery` index,
`IntentStore`, `InputJournal`, `InteractionLedger`, `TransitionState` (with `StoreGenerations`),
`TransitionReadiness`, `DELETE FROM engine_slots`, `thread_ownership`. A refusal
(`IncompatibleDataError` from `requireEngineVersion` or `requireEngineColumns`) is thrown from the
facade's constructor at the same point the TypeScript throws it.

- Rust's `Repo::open` runs none of these. It prepares nothing at open (statements are cached on
  first use) and reads nothing, so open is O(1) in history.
- A later item whose TypeScript constructor does its own open work (for example
  `ContextMeters(store, …)`, `index.ts:320`) adds that constructor to this file, in the
  TypeScript engine's order. The file's doc comment says so.
- Every statement in that sequence is idempotent on an existing home (`IF NOT EXISTS`, or a check
  that returns early). Two kinds are not O(1) on every home: an index created for the first time on
  a home that predates it, and the orphan sweep `DELETE FROM engine_input_echoes WHERE thread_id
  NOT IN (SELECT id FROM threads)` (`input-journal.ts:98`), plus `migrateEmptyCursorThreads`. The
  TypeScript engine runs them today, so the native engine adds nothing; E5.3 times open on a cold
  large-home clone (Proof) and reports them, and does not fix them (open question 4).

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

`ace-core` today folds over `IndexMap` sections. Introduce in `ace-core/src/section.rs` a map type
the core uses for every record section of `ThreadState` (`agents`, `runs`, `items`,
`interactions`, `tasks`, `interactionHistory`, `taskHistory`, `itemLinks`, and the eight
`indexes` maps), with exactly the operations the core calls today: keyed `get`, `get_mut`,
`insert`, `remove` (`shift_remove`), `contains_key`, and ordered iteration. In the core today only
`agents` is iterated (9 sites); every other section is reached by key.

```rust
/// Pure: the core never does I/O. A section either owns all its entries (the default, which
/// `@ace/core`'s facade, `ace-core-wasm` and every core test use, unchanged) or is backed by a
/// `RecordSource` the engine injects, which loads one key or the key list on a miss.
pub trait RecordSource<T> {
    fn load(&self, key: &str) -> Result<Option<T>, SourceError>;
    fn keys(&self) -> Result<Vec<String>, SourceError>;
    fn touched(&self, key: &str, value: Option<&T>); // a write or delete the engine must persist
}
pub struct Section<T> { /* resident IndexMap, Option<Rc<dyn RecordSource<T>>> */ }
```

- With no source, `Section<T>` behaves as the `IndexMap` it replaces: same serde form, same key
  order, so the E4 (a) files and the core vectors pass unchanged. Run the core's own tests and its
  facade tests with `ACE_CORE=native` before and after; nothing in them changes.
- With a source, a miss calls `load`; iteration calls `keys` once per transaction (the
  TypeScript caches the enumeration while tracking, `records.ts:153`–`:172`) and merges the
  overlay. Key order is the TypeScript `ownKeys` result: the stored keys in `rowid` order, then the
  overlay's additions, then **JavaScript object order** applied on top
  (`Object.keys(Object.fromEntries(...))`, `:171`): integer-like keys first in ascending numeric
  order, then the rest in insertion order. A test pins it with keys `"10"`, `"2"`, `"b"`, `"a"`.
- A load or keys failure (`SourceError`) surfaces from the fold as a fold error. The engine maps it
  to the same error the TypeScript throws there (`Invalid snapshot record`, `records.ts:16`, or the
  SQLite error).
- The engine's `RecordSource` is `records::Records` (step 4); the core never sees SQL.

If the core reviewer rejects a source-backed section, the fallback is open question 1.

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

### 8. Rollback and the record cache

The TypeScript keeps no undo log for in-memory state. It drops what may be stale and reloads from
SQLite, and E5.3 does the same:

- **The generation.** `syncSnapshots` (`repository.ts:200`) compares the store's
  `rollbackGeneration()` (`store.ts:593`) with the one it last saw. When it moved, every resident
  snapshot **without a pending live write** is dropped and released, and the generation is
  recorded. The store bumps it on a top-level rollback, a nested rollback (`store.ts:624`, `:629`,
  through the native shell's `topRolledBack` and `nestedRolledBack`) and a failed history install
  (`:980`, outside the stack). Rust reads it through a new synchronous port,
  `rollbackGeneration(): number` (a number, no JSON), at each point the TypeScript calls it:
  `state()`, `save()`.
- **Dropping is releasing.** A dropped snapshot's sections clear their budget entries and turn
  uncached (step 2). A task still holding its `Rc` keeps working on it, and its reads go to SQLite,
  as a state kept past release does today (`snapshot-release.process`).
- **Live writes survive.** A snapshot with a pending live write is never dropped by a rollback or
  by `trim`. Its buffered deltas are not in SQLite yet, so reloading would lose them. The buffer's
  own retry and quarantine decide them (E5.2, `live-write-quarantine.process`).
- **Overlays are per snapshot, not per transaction frame.** `touched`, `patches`, `originals`,
  `replaced` and `appended` clear only on `committed()`. After a rollback the snapshot holding
  them is dropped at the next `state` or `save`, so they are never persisted. That includes a
  savepoint rollback caught inside a still-open outer transaction: the nested rollback bumps the
  generation, and the next `save` in the same outer transaction reloads first
  (`snapshot-rollback.process:123`).
- **What never happens:** a rolled-back value staying in the budget under a resident snapshot, or
  a snapshot reused across a rollback with an unchanged `seq`. The `seq` check alone cannot catch
  the second (`snapshot-rollback.process:98`: a nested save whose event sequence did not change),
  which is why the generation exists.

### 9. The startup candidate scan (`repository/candidates.rs`)

E5.1's `ready()` loops on `repository::recovery_candidates(state, 256)` until a slice comes back
empty, then marks the engine ready. E5.3 replaces the stub and changes its signature to take the
`EngineStore` (the scan needs SQL), with the matching one-line change at E5.1's two call sites
(`lib.rs`, `ready_steps`).

- **The set** is `repository.ts:259`–`:266`'s union: threads whose `json_extract(status,'$.state')`
  is not `new`, `done` or `failed`; threads with an intent `pending`, `queued` or `running`, or
  `awaiting=1`, or `uncertain=1`; threads with an `engine_queue` row with a continuation, a
  trigger, `limited=1` or `paused=1`; each only if it has a `thread_state` row.
- **The slices.** Three cursors, each paging its own table by primary key, 256 rows a slice:
  `threads` by `rowid`, `intents` by `id`, `engine_queue` by `thread_id`, each with the same
  predicate on that page only. A slice is one pump step: one `EngineStore::atomic` (the TypeScript
  runs each page in `store.atomic`), then a yield to the executor. A table with millions of rows
  costs millions/256 steps, each bounded, and the event loop runs between them.
- **The order.** The TypeScript recovers candidates in `thread_id` order. The scan collects the
  candidate ids (a set the size of the candidates, not of history) and, once every cursor is done,
  hands them back in `thread_id` order, 256 per call, each recovered in its own pump step (E5.8).
  So the recovered set and its order are what the TypeScript gives.
- **Unreadable state** (`:270`–`:277`): a candidate whose state fails to decode with an error
  `skippableAtStartup` accepts is reported and skipped; anything else fails readiness, as today.
- Delete the probe's `emptyCandidates` stub and `State.probe_empty_candidates` (E5.1 step 12 says
  E5.3 does).
- `states()` (`:283`) reads every `thread_state` id at once. Port it as it is: it has no caller on
  the startup path. Name its callers in the module comment.

## Migrations: stay TypeScript (recommended)

`migrateEngine` (`migrations.ts:9`) creates a fresh schema or refuses an old one; it never
upgrades. Around it, about twenty steps in more than a dozen modules create their tables and
indexes at open (step 1). Options:

- **Stay TypeScript (recommended).** The opener runs the same constructors in the same order, so
  the DDL has one source, and a home made by either backend is made by the same statements.
  The cost is one TypeScript object graph built and dropped at boot, with no history-sized work.
  The open statements move to Rust verbatim (same text, same order) when the TypeScript engine is
  deleted, one release after default-on (ADR 0223 §8).
- **Move now.** Rust would hold a second copy of every one of those statements while the
  TypeScript files that hold them stay live until deletion, and a drift between them (one column or one
  partial-index predicate) would make a native-created home refuse to open with the switch off,
  breaking constraint 2. It would also put E5.3 in files that E5.4 to E5.9 own.

The Rust side checks only the per-row snapshot version (`requireSnapshotVersion`), which runs on
every decode, not at open.

## What "Rust commits publish through the JS shell" costs

E5.1 decision 6 left this to E5.3. One engine step commit (a `save` from a fold) with the switch
on crosses napi this many times:

| Crossing                                                                                                                                                                   | Count per commit            | Data                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------- |
| shell `open` (flush, context, `stack.begin`)                                                                                                                               | 1 call                      | none                                                        |
| `rollbackGeneration`, `hasLiveWrite`, `headSeq`                                                                                                                            | 1 each per `state`/`save`   | numbers, booleans                                           |
| `writeEvents(threadId, payloadsJson, at)`: Rust encodes, JS `JSON.parse`s, the store's writer runs, and with `ACE_STORE_WRITER` it crosses back into `ace-store` per event | 1 call + 1 per event inside | the payloads twice (Rust → JSON → JS → the store's encoder) |
| shell `close` (`succeed`, `Finish` JSON, settle, publish, `releaseWakes`)                                                                                                  | 1 call                      | the `Finish` JSON                                           |

The engine's own rows (`thread_state`, records, appends, admission) cross nothing: they run in Rust
on the connection. Measure it (Benches) as engine step commit p50 and p95, switch off and on, and
report both with the number of events per commit. The gate (ADR 0223 §8) is "no slower". If the
switch-on figure is slower and the payload round trip is the cause, report it with the split; the
fix is the store's event-writer orchestration moving to Rust (ADR 0226), not a second writer in the
engine (Decision 1).

## Proof

Every (a) and (b) file is run alone, switch off and on (rule 3), with `ACE_STORE=native`,
`ACE_STORE_WRITER=…,transactions` and a fresh `ACE_ENGINE_EVIDENCE` for the switch-on run, which
must be non-empty afterwards. With the switch off every file passes unchanged: E5.3 edits no
TypeScript engine module.

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
deleted when that file first passes switch-on):

- "the engine constructs, becomes ready, flushes and closes on a fresh home and on a seeded one,
  with one evidence line" (the smoke; no probe stub left);
- "a fold of a scripted batch writes the same `thread_state` header, records and appends a
  TypeScript fold of the batch wrote, as read back through `store.snapshotThread`" (expected values
  are the fixture's literal results, not a second run of the TypeScript);
- "a rolled-back fold leaves no record in the budget, and the next fold reloads from SQLite";
- "startup recovery of 600 candidate threads takes at least 3 slices, with the event loop running
  between them, and `ready()` resolves after the last" (a `setImmediate` counter advances between
  slices).

The fold seam tests need the collaborators. The probe adds, under `engine-probe` only,
`probe.passThroughCollaborators()`: unported collaborator calls return the fact unchanged or no
rows, so a fold of plain item and turn facts runs before E5.4 to E5.9 land. It is scaffolding, the
probe's one new stub, and the last owner to land deletes it (open question 2).

**Home tests** (`native-engine/persistence-home.process.test.ts`, the real edge is a second
process):

- **TypeScript-written, native-read.** `engineSeam({ seedWithTypeScript })` runs a child with the
  switch off that creates threads through the TypeScript engine with a scripted adapter (one
  working, one done, one with an unreadable header, one with appended text past 32,768 code
  units), then exits. The native engine opens the home: `hasState`, the candidate set, the
  skipped thread's report and the folded text read as the fixture expects.
- **Native-written, TypeScript-read.** The seam folds the same batches natively, closes, then a
  child with the switch off opens `new Engine` on the home, awaits `ready()`, and prints
  `store.snapshotThread` for each thread; the test asserts the fixture's values.

**Cross-mode run.** The E5 list (ADR 0223 §8) needs restart, so its first run is E5.8's
(E5.1 brief, Benches). E5.3 runs `scripts/native-cross.ts ACE_ENGINE` on each file of the list
only to record which fail as "no restart" and which fail at an unported step, and puts that list in
the PR. The home tests above are E5.3's rollback proof until then.

**Open time.** On an APFS clone (`cp -c`) of a large home with a cold cache, never with a daemon
on the clone (never-run-daemon rule), time the opener and `Repo::open`, switch off and on, and the
candidate scan's slices (count, longest). Report the slow open statements named in step 1.

## Benches

Switch off and on, same machine, figures in the PR:

- **`bench/sqlite-store.ts --split`.** Add an `engineCommit` figure to its report: N fold-and-save
  commits of a fixed batch (one `item.upsert`, ten `item.delta`, one `turn.ended`) on one thread,
  through `EngineRepository.apply` with the switch off and through the probe's fold with it on
  (the bench needs the `engine-probe` build for the on figure, and says so). Report p50, p95 and
  events per commit. This is the cost of the table above, and the figure ADR 0223 §8 gates E5's
  commits on. It extends an existing bench; no new file.
- **`bench/stream-history.ts`.** It folds through `@ace/core` and builds no `Engine`, so it
  measures the core's record work, not persistence. Run it with `ACE_CORE` off and native as the
  baseline, and confirm the `Section` change (step 3) did not move it: same `records` and timing
  within noise.
- **`bench/scripted.ts`.** It drives the engine through scripted sessions, which reach the native
  engine only through `JsSession` (E5.6). Record the switch-off baseline now; the switch-on figure
  is E5.6's.

## Files (all yours; nothing else)

- `ace-engine/src/{repository,snapshot,records}.rs` and their directories as the module map lists.
- `ace-engine/src/lib.rs`: `Tx::conn()`, the connection on `EngineStore`, the candidate scan's
  call sites, and the removal of `probe_empty_candidates`. Nothing else.
- `ace-core/src/section.rs` and the `ThreadState` field types (core reviewer, step 3).
- `ace-store/src/stmt_cache.rs`: a `run(conn, sql, params) -> (changes, last_insert_rowid)`
  beside `all_rows` and `get_row` (store reviewer). The engine's writes use it.
- `ace-daemon-node/src/engine/{repository,probe_repository}.rs`, and `mod` lines for them in
  `engine/mod.rs`; the three new ports (`writeEvents`, `rollbackGeneration`, `bufferLiveWrite`'s
  token callbacks) in `engine/ports.rs` and `native-engine/ports.ts`.
- `apps/daemon/src/native-engine/{repository,records,snapshot,open}.ts`, the probe methods and the
  stub removal in `testing.ts`, `persistence.test.ts`, `persistence-home.process.test.ts`.
- `apps/daemon/bench/sqlite-store.ts` (`engineCommit`).
- `ace-engine/tests/fixtures/engine-schema.sql`.

## Must not

- Write `events`, `threads`, `items` or `payloads` rows, or any store table, from engine SQL.
- Add, drop or change a table, column, index, section name or JSON field; bump
  `engineSchemaVersion`.
- Create an index or run a full-table statement at open that the TypeScript does not run.
- Run the startup scan as one statement, or recover a thread inside the scan's slice.
- Keep an undo log instead of the generation rule, or reuse a snapshot across a rollback.
- Edit a TypeScript engine module, or another E5 item's Rust files beyond deleting a line
  `collaborators.rs` names.
- Fall back to the TypeScript engine, or no-op an unported collaborator outside the probe.

## Reviewer checks

- Every SQL string in `ace-engine` is the TypeScript's text, with its source line in a comment, and
  sits at the same transaction boundary (Decision 3).
- The budget's limits, weights and eviction callback match `record-cache.ts` and
  `bounded-cache.ts`; byte counts are UTF-8 with lone surrogates as 3; patch coalescing counts
  UTF-16 units.
- Header key order: spread-then-override, `engineSnapshot` in place; section enumeration in
  JavaScript key order.
- `syncSnapshots` runs before every `state` and `save` read, spares live-write snapshots, and
  releases what it drops.
- The candidate scan's three predicates equal `repository.ts:259`–`:266`, each slice is one pump
  step, and the recovered order is `thread_id`.
- The opener constructs the TypeScript repository and the Rust open runs no statement.
- `cargo test -p ace-engine`, `-p ace-core`, `-p ace-store`, `check:daemon-native`, and every file
  above alone, off and on.

## Open questions

1. **The lazy section in `ace-core`** (step 3). Recommended: `Section<T>` with an optional
   `RecordSource`, reviewed by the core owner. The core already reaches every section but `agents`
   by key, so the change is contained. Fallback if rejected: the engine loads, before each fold, the
   records the batch can touch (the facts' agents, items, runs, interactions and tasks, and every
   agent and index) into a partial state, and writes back what changed. That moves the read set
   into engine code that must track every key the core may read. Fragile, so not recommended.
2. **The probe's pass-through collaborators.** Recommended: accept them as test-only scaffolding
   (`engine-probe` only), so the fold has a native proof at E5.3. Without them the fold's first
   native run waits for E5.4, E5.7 and E5.9.
3. **The rollback generation as a port.** Recommended: a synchronous number-valued port, which
   sees all three bump sites, including the history install outside the stack. If the `engineCommit`
   bench shows the per-call cost matters, the shared stack can count its own rollbacks and the store
   can note the history-install one with one call at `store.ts:980`, which is a store-file edit.
4. **Slow open statements the TypeScript already runs** (step 1: first-time index creation on an
   old home, the `engine_input_echoes` orphan sweep, `migrateEmptyCursorThreads`). Recommended:
   report the cold-clone timings in the PR and file one issue to move them to idle batches (ADR
   0170). That is a TypeScript change for both backends, not part of E5.3.
5. **`writeEvents` and its double payload crossing.** Recommended: accept it for E5 and gate on
   `engineCommit`. If it is slower than switch-off, the event writer's orchestration (payloads,
   history, status, long threads, search, hooks) moving to Rust is the fix, under ADR 0226, so the
   engine hands `ace-store` its payloads with no JSON round trip.
6. **`states()` reads every `thread_state` id** (`repository.ts:283`). It is ported unchanged.
   Recommended: the builder lists its engine callers in the PR (a grep for `.states()` also finds
   unrelated methods of that name). If any runs on startup or on the main
   thread over a large home, it becomes a sliced scan like step 9, in the item that owns the caller.
