# Porting the store to Rust: phases 1b to 5

For the builders who move the event store to Rust: the reads (phases 1b, 2 and 3, in parallel,
one phase each), the storage format (phase 4) and the writer (phase 5, as ordered build tasks). Read
[ADR 0222](../adr/0222-the-event-store-moves-to-rust-behind-the-same-store.md) and
[behaviour.md](behaviour.md) first; the contract there is what you keep. Branch from
`ace/rust-store`.

## What already exists (phase 1a)

- `native/daemon` (Cargo workspace). `crates/ace-store/src/sqlite.rs` is the connection the
  TypeScript store runs on with `ACE_STORE=native`: `Connection`, `Statement`, `Value`. It is
  the only unsafe code in the workspace and you do not change it. If a phase needs something
  from SQLite it does not offer, stop and ask; do not add unsafe code elsewhere.
- `crates/ace-daemon-node` is the N-API addon. `NativeDatabase::connection()` gives a binding
  the same `Arc<Connection>` the TypeScript store's statements run on, so a native read sees
  the open transaction's rows exactly as a TypeScript read would.
- `packages/provider-kit/src/native-sqlite.ts`: the node:sqlite surface over the addon, and
  `nativeHandle(db)`, which turns the store's `DatabaseSync` into the addon object a read
  binding takes as `&NativeDatabase`.
- `apps/daemon/src/native-reads/switch.ts`: `nativeReads("items" | "long" | "sidebar")`,
  from `ACE_STORE_READS` (needs `ACE_STORE=native`). Every native read is behind it.

## Rules for every phase

1. **Same TypeScript interface.** `Store`'s methods keep their signatures and return the same
   objects. You replace the loader inside a TypeScript method, not the method. Caches
   (`ThreadReadCache`, the sidebar caches), the flush before every read, freezing, and the
   head (`seq`) a result carries stay in TypeScript, around your call.
2. **No new tests.** The class (a) test files listed for your phase are the proof. Run each one
   alone, with the switch on and off:
   `ACE_STORE=native ACE_STORE_READS=<kind> bun --bun x vitest run <file> --maxWorkers=4` and
   `bun --bun x vitest run <file> --maxWorkers=4`. Check the path exists first: an empty path
   runs the whole suite. Never run the full suite, `bun run test` or `bun run check`; the
   machine is shared.
3. **Rust: idiomatic, safe.** No `unsafe`, no `unwrap`/`expect` (clippy denies them), errors as
   `ace_store::Error` or your own `thiserror`-style enum mapped in the binding. Build with
   `PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH CARGO_BUILD_JOBS=4
   cargo build --release -p ace-daemon-node` in `native/daemon`; run `bun run
   check:daemon-native` before committing. Use crates for available work (`serde_json` with
   `raw_value` is already a dependency of `ace-store`); add one only with a reason in its
   `Cargo.toml` comment and check it against `deny.toml`.
4. **Bindings only translate.** Every `#[napi]` function carries `catch_unwind`. It takes
   `&NativeDatabase` and plain arguments, calls your `ace_store::reads::<phase>` function, and
   returns one JSON string. The TypeScript shell `JSON.parse`s it. Return stored JSON as stored
   (`RawValue`); never re-encode a stored body.
5. **Trust (ADR 0125).** Your read gets the store's trust floor and rejected sequences from the
   shell (`StoredTrust`, `stored-decode.ts:45`). Rows at trusted sequences go out as stored.
   Rows that are not trusted are marked in your output, and the shell decodes them with the
   existing lenient decoders (`decodeStoredItem`, `decodeStoredPayload`); do not port Zod.
6. **One transaction view.** You read on the store's connection, never on a new one: no reader
   pool in these phases. That keeps read-your-writes inside `atomic` and the savepoint
   snapshots the sidebar takes.
7. **Same numbers.** Page sizes, byte budgets (UTF-8 bytes of the JSON the client gets),
   cursors (`itemsBefore`, `before`), the crossing-item rule and the "partial" and "cut" flags
   are contract. Where the TypeScript counts bytes with `Buffer.byteLength(JSON.stringify(x))`,
   count the bytes of the JSON you emit; they must agree.
8. **Commit and push as you go** to your phase branch with
   `git push origin HEAD:refs/heads/<your-branch>`; never rebase or force-push. Every commit ends
   with exactly `Co-Authored-By: spade <bot@acehq.dev>`.
9. **Measure before you finish:** `bun apps/daemon/bench/sqlite-store.ts --db=<clone> --split`
   with your switch off and on, on an APFS clone (`cp -c ~/.ace/events.sqlite* <tmp>/`). Never
   start a daemon or any ace command on a clone. Report both, and delete the clone.

## Files per phase

Each phase owns its own files, so three builders never edit the same one. The module
declarations already exist.

| Phase         | Rust read                                   | Binding                                     | TypeScript shell                              | Switch    |
| ------------- | ------------------------------------------- | ------------------------------------------- | --------------------------------------------- | --------- |
| 1b items      | `crates/ace-store/src/reads/items.rs`       | `crates/ace-daemon-node/src/items.rs`       | `apps/daemon/src/native-reads/items.ts`       | `items`   |
| 2 long-thread | `crates/ace-store/src/reads/long_thread.rs` | `crates/ace-daemon-node/src/long_thread.rs` | `apps/daemon/src/native-reads/long-thread.ts` | `long`    |
| 3 sidebar     | `crates/ace-store/src/reads/sidebar.rs`     | `crates/ace-daemon-node/src/sidebar.rs`     | `apps/daemon/src/native-reads/sidebar.ts`     | `sidebar` |

The one edit outside these files is the call site: a single `if (nativeReads(kind)) return …`
at the top of each TypeScript loader you replace (listed below). Keep it to that line.

## Phase 1b: item pages, windows and tails

Measured: scroll back 73–76% inside SQLite, 112 statements per 50-item page; first thread open
73–75%, 218 statements; items window 60–62%, 322 statements.

Replace these loaders (the caches and flush around them stay):

- `ItemStore.wirePage` (`apps/daemon/src/item-store.ts:281`), behind `PayloadStore.wirePage`
  (`payload-store.ts:400`), used by `readItemPage` and `readBoundedItemPage`
  (`thread-reads.ts:240`, `:255`).
- `ItemStore.page` (`item-store.ts:598`), behind `readItems` (`thread-reads.ts:227`).
- `ItemStore.window` (`item-store.ts:432`), behind `itemsWindow`
  (`long-thread/queries.ts:88`).
- `ItemStore.tail` (`item-store.ts:534`), the transcript of `snapshotThread`
  (`thread-reads.ts:142`).

Contract to keep (behaviour.md): §8 rows for `readItems`, `readItemPage`,
`readBoundedItemPage`, `snapshotThread`, `itemsWindow`; §7 snapshots (default tail 200 items
and 1 MiB, small tails say they are partial and name previewed items); item text is the body
plus its append-only chunks in sequence (§14, `item-text-store.ts:217`); a page never adds
chunks to a body another connection completed while it read; the bounded page never fails on
one oversized item; raw payloads are left out where the TypeScript leaves them out.

Proof (class a): `item-store-trusted-reads.test.ts`, `stored-history-trust.test.ts`,
`text-storage.process.test.ts`, `payloads.process.test.ts`, `subscription-snapshot.test.ts`,
`subscription-tail.test.ts`, `subscription-replay.test.ts`, `store-live-writes.test.ts`,
`agent-control/thread-read-paging.process.test.ts`, `pending-pages.process.test.ts`,
`reply-bounds.process.test.ts`, `write-path-reads.test.ts`, `store-read-cache.test.ts`,
`store-held-view-rollback.test.ts`.

## Phase 2: long-thread reads

Measured: turns page 93% inside SQLite, 51 statements and 1,708 rows per page; catch-up 93%;
in-thread search 98%.

Replace the SQL-and-shaping parts of `LongThreadQueries` (`apps/daemon/src/long-thread/queries.ts`):
`turnsPage` (`:51`), `turnSteps` (`:56`), `threadSearch` (`:192`), `threadCatchUp` (`:215`),
including what they call in `long-thread/turn-digests.ts`, `long-thread/digests.ts` and
`long-thread/steps.ts`. `itemsWindow` belongs to phase 1b. The request is still parsed with
its protocol schema in TypeScript, and `authorize` stays a TypeScript callback: pass the
authorized thread ids in, or call back per descendant before anything of it is read.

Contract to keep: behaviour.md §8 row for these reads; a page of turns reads each turn the
same as a page holding that turn alone; at most 64 files and 64 commands per turn, with the cut
flagged; index rows an older build left are validated, never sent as stored (trust rule 5);
a negative index count reads as zero where it always did and fails elsewhere; catch-up refuses
a denied descendant before revealing anything of it; time-based catch-up excludes child work
before the cutoff.

Proof (class a): `long-thread-turns-page.test.ts`, `long-thread-lifecycle.process.test.ts`,
`long-thread-recovery.process.test.ts`, `search-replay-budget.process.test.ts`,
`search-replay-streams.process.test.ts`, `search-replay-many-parts.process.test.ts`,
`search-replay-attachments.process.test.ts`, `search.outputs.process.test.ts`.

## Phase 3: the sidebar and thread lists

Measured: sidebar page 71–74% outside SQLite, 942 statements per page; listing all threads
68–69% outside SQLite (2,923 rows decoded in JavaScript).

Replace the loaders, not `SidebarReads`' caches or snapshot:

- `sidebarPageStorage` (`apps/daemon/src/sidebar-page-storage.ts:60`), what
  `SidebarReads.loadSidebarPage` (`sidebar-reads.ts`) calls inside the store's read savepoint.
- The thread row decode for lists: `Store.listThreads` (`store.ts:1169`) and
  `Store.readThreads` (`store.ts:1070`). The shell still freezes what it returns and records
  each entry's row revision (`sidebarRowRevisions`), and `ThreadCache` keeps serving single
  threads.
- Leave `liveWindow` (the in-memory sidebar index) in TypeScript.

Contract to keep: behaviour.md §7 sidebar caches and §8 sidebar row; pinned and unsettled
threads first, then 20 settled per page; membership and rows from one snapshot; tabs, filters,
counts and order equal to what the threads JSON gives (`sidebar-columns.test.ts`); a thread
whose JSON cannot be read never blocks a write and lists once fixed; each row carries this
device's read cursor; thread row trust (`thread-row-trust.ts`) decides which rows go out as
stored.

Proof (class a): `sidebar-columns.test.ts`, `sidebar-live.process.test.ts`,
`sidebar-pagination.process.test.ts`, `sidebar-tabs.process.test.ts`,
`sidebar-read-state.test.ts`, `sidebar-revisions.test.ts`, `thread-row-trust.test.ts`,
`thread-cache.process.test.ts`, `thread-columns.process.test.ts`,
`revision-triggers.process.test.ts`, `store.test.ts`.

## When you are done

Report, per proof file, the result with your switch on and off; the bench numbers before and
after; and anything in the contract you could not keep. Phases 1b to 3 change neither the writer,
the storage format nor any stored data; those are phases 4 and 5, below.

## Rules for phases 4 and 5

These add to the rules for every phase above; where they differ, these win for phases 4 and 5.

1. **Builders get one task at a time**, in the order given. A task's brief lists every file it
   may touch. Anything else, including a file the brief does not name, needs the reviewer's
   yes first. Branch from `ace/rust-store-writer` (or the branch the orchestrator names) and push
   with `git push origin HEAD:refs/heads/<your-branch>`; check it landed with
   `git ls-remote origin refs/heads/<your-branch>`.
2. **Tests move, they don't multiply.** The proof is the existing (a) files run with the
   switch on and off. The only new checks allowed are the vectors named in a brief (generated
   from the TypeScript, as ADR 0207 did for history) and a test for behaviour nothing covers
   today, which the brief names. No parity harness, no duplicate suite, no test that compares
   the two backends against each other in one process.
3. **Run tests one file at a time.** Check the path first: an empty path runs the whole suite.

   ```sh
   f=apps/daemon/src/store.test.ts
   test -f "$f" || { echo "missing $f"; exit 1; }
   ACE_STORE=native ACE_STORE_WRITER=<part> bun --bun x vitest run "$f" --maxWorkers=4   # on
   ACE_STORE=native bun --bun x vitest run "$f" --maxWorkers=4                           # off (native connection)
   bun --bun x vitest run "$f" --maxWorkers=4                                            # off (TypeScript)
   ```

   "On and off" in the briefs means all three runs. Never run the full suite, `bun run test` or
   `bun run check`.

4. **Build and lint the Rust** in `native/daemon` with rustup's toolchain first in `PATH` (plain
   `cargo` is Homebrew's):

   ```sh
   export PATH=$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH CARGO_BUILD_JOBS=4
   cd native/daemon
   cargo fmt --check && cargo clippy --all-targets -p <crate> && cargo test -p <crate>
   cargo build --release -p ace-daemon-node
   cd ../.. && bun run check:daemon-native
   ```

   `cargo clean` in `native/daemon` when the task is done.

5. **JavaScript-visible values go through `ace-json`** (`native/daemon/crates/ace-json`, its
   rules are in `src/lib.rs`), never `serde_json::Value` and never a Rust `String` for a
   JavaScript string. The E4 reducer work found each of these divergences by hitting it:
   - key order: `ace_json::Map` keeps JavaScript's order (array-index keys first, ascending,
     then insertion order; `insert` on an existing key keeps its place, as `object[key] = v`
     does; `shift_remove` is `delete`). Never sort keys, never rebuild an object in a different
     order, and add new keys in the order the TypeScript statements add them, not in the order
     of the input;
   - numbers: `ace_json::Number` is one f64 and prints as `Number.prototype.toString` (`1e21`,
     `1.5e-7`, `1` for `1.0`, `0` for `-0`). Never format a number by hand; integers that cross
     N-API as `f64` are checked with `Number.isSafeInteger`'s rule (`|n| <= 2^53 - 1`, integral);
   - strings: `ace_json::JsString` is UTF-16. A lone surrogate (`"\ud800"`) parses, survives and
     prints as `\ud800`. Lengths are UTF-16 units where the TypeScript uses `.length`, and
     UTF-8 bytes counted as `Buffer.byteLength` counts them (a lone surrogate is 3 bytes) where
     it uses that. Concatenation joins UTF-16 units, so the two halves of a pair split across
     two strings join into one character;
   - `__proto__` is an ordinary own key; a duplicate key replaces the earlier value in place;
   - nothing recurses: parse, clone, compare and print use `ace-json`'s heap stack;
   - stored JSON that Rust passes on without changing stays as text (`ace_json::Raw`/`RawRef`,
     or the string the TypeScript gave), never parsed and printed again.
6. **Inject what you can't control.** No `SystemTime::now`, no random ids, no thread spawning,
   no globals in `ace-store` or `ace-projection`. Time, ids and schedulers are arguments.
7. **Errors, not panics.** No `unwrap`, `expect`, `panic!`, `unreachable!`, indexing that can
   panic, or `as` casts that can truncate, outside `#[cfg(test)]`. Every `#[napi]` export keeps
   napi's `catch_unwind`. A TypeScript error message that callers or tests match (`Unknown
   thread`, `Sequence exhausted`, `workspace_unregistered`, `Store is busy`) is reproduced
   byte for byte.
8. **Placement must not leak into logic** (ADR 0222 §3, ADR 0223 §5). Phase 5 runs on the main
   connection and the thread that owns it: the JS thread while TypeScript calls `Store.atomic`
   synchronously. Write the Rust so that moving that owner to a Rust core thread later changes
   the binding only:
   - writer types are plain structs that take `&Connection` (or hold an `Arc<Connection>`) and
     `&mut self`; they never spawn, block on a channel, sleep, or assume which thread they run on;
   - no callback from Rust into JavaScript inside a call (ADR 0222, owner's answer 6), and no
     N-API env held across calls;
   - work that must happen after a commit (publication, settlements, cache eviction) is
     returned as data for the caller to run, never invoked from inside `ace-store`;
   - timers are deadlines returned to the caller ("flush due at t"), never owned by the crate.
9. **The switch.** `ACE_STORE_WRITER`, a comma list of `fold`, `sequences`, `events`, `live`,
   `transactions`, read once in `packages/provider-kit/src/native-switches.ts` next to `ACE_GIT`
   (export `storeWriterOn(part)` and `storeWriterParts()`), off by default. It needs
   `ACE_STORE=native` and refuses to start without it, and each part refuses to start without
   the parts before it in that list. Like `ACE_STORE` it takes its value once per process, at
   the first database boot: add it to `CrossSwitch` the way `ACE_STORE` is, so the cross-mode
   gate (ADR 0223 §8) restarts a home written in one mode in the other. Task 5.1 adds the
   switch; later tasks only add their part's name.
10. **Benches** run on an APFS clone or a throwaway home, never on `~/.ace` and never with a
    daemon or `ace` command on a clone (`never-run-daemon-on-live-home-clone`):

    ```sh
    tmp=$(mktemp -d) && cp -c ~/.ace/events.sqlite* "$tmp"/
    bun apps/daemon/bench/sqlite-store.ts --db="$tmp/events.sqlite" --split          # reads and the write phase's commit p50/p95, WAL pages
    bun apps/daemon/bench/event-writes.ts "$tmp/events.sqlite" 3000 7               # CPU per appended event
    bun apps/daemon/bench/live-write-buffer.ts                                       # live path, throwaway harness
    bun apps/daemon/bench/allocation-rate.ts                                         # allocation rate, temp ACE_HOME
    rm -rf "$tmp"
    ```

    Each with the part on and off, alternating, reporting medians. A part stays off until its
    numbers are no worse than off (ADR 0222 §7); a slower part may still merge switched off,
    with the numbers in its PR.

## Phase 4: the storage format

ADR 0222 §6 steps 1 and 2, and the search cap from the owner's answer 2. Each step changes rows
written after it ships; old rows stay as they are, and nothing history-sized runs at open
(ADR 0170). The read side of every step ships, and is on, a release before its write side can be
turned on. Recompression of old rows and cold storage are later work with their own switches
(owner's answers 3 and 4) and are not part of phase 4.

Switch: `ACE_STORE_FORMAT`, a comma list of `refs` (step 4.2), `zstd` (step 4.3) and
`search-cap` (step 4.4); ADR 0222's `ACE_STORE_FORMAT=2` means `refs,zstd`. It switches the
write side only. The read side has no switch: once shipped, it always reads both formats.

### 4.0 The rollback contract (write and review this before any code)

ADR 0222 §7 requires it first. The builder of 4.1 turns each rule below into a checklist entry
with the code that satisfies it, and the reviewer signs the list off before 4.2 starts.

1. **A build with the format switch off reads every row written with it on**, through every
   path: the `Store` methods, the Rust reads (`crates/ace-store/src/reads/`), and direct SQL in
   `atomic` callers. This holds with `ACE_STORE` off too: decoding a body is a pure function of
   the addon that needs no connection, so a node:sqlite store can call it without breaking the
   one-SQLite-per-file rule. A store that finds a format-2 row and cannot load the addon fails
   open with a message naming the addon, never misreads.
2. **Builds older than the read side** must refuse a home that has format-2 rows rather than
   misread it. Check whether `migrate` refuses a newer `schemaVersion` (`migrations.ts:237`); if
   it does, the read-side release adds one migration step (an O(1) `ALTER TABLE ... ADD COLUMN`,
   ADR 0170) so older builds refuse it. If it doesn't, stop and ask.
3. **SQL that looks inside a body keeps working.** Every `json_extract`/`json_each` over a body
   column, every partial index on one, and every trigger that reads one must give the same
   answer on a format-2 row. Found so far (4.1 makes the full list):
   `events.payload` in `engine/handler.ts:419` (`$.run.agentId`, `$.item.agentId`, `$.item.role`,
   `$.item.synthetic`) and `engine/transition-history.ts:45` (`$.runId`);
   `history_item_revisions.item` in the partial index `history_completed_revisions`
   (`history-index.ts:102`, `$.complete`) and `history-search-replay.ts:85` (`$.agentId`, `$.id`,
   `$.createdAt`, `$.type`, `$.call.detail.kind`, `$.complete`). `items.item` readers
   (`agent-control/forks.ts:44`, `engine/transition-history.ts:142`, `engine/title-input.ts:5`,
   `browser-artifact-files.ts:19`) are not changed by phase 4 because phase 4 leaves `items`
   alone; the list must say so. The rule that meets this: a format-2 row keeps, in its JSON
   column, a stub object holding exactly the paths SQL reads (in the order the full body has
   them), and the full body goes in the new column. A path that cannot be in a stub is a reason
   not to convert that column.
4. **Sizes stay the sizes of the JSON.** `bounded-events.ts:37` sizes ranges with
   `octet_length(payload)`; replay pages and byte budgets (behaviour.md §8, §13) are counted on
   the JSON a client gets. Format-2 rows store the uncompressed byte length in a column, and every
   size query reads `coalesce(body_size, octet_length(payload))`.
5. **A reference revision survives every rewrite and removal of the row it points at.** A
   revision stored as "same as the item in the event at seq N" must be made whole again, in the
   same transaction, before any statement that rewrites or deletes event N: `PayloadStore`'s
   migration that caps and rewrites payloads (`payload-store.ts:139`, `UPDATE events SET
   payload`), `deleteThread` (`store.ts:1412`), `purgeThreadData` and `storage/transcript.ts`
   (bounded batches: revisions before events, or a crash between batches leaves a dangling
   reference), retention (`storage/data-retention.ts`) and compaction (`storage/compaction.ts`
   if it touches `events`). 4.1 lists every `DELETE FROM events` and `UPDATE events` with
   `rg -n "(DELETE FROM|UPDATE) events" apps/daemon/src packages`. A reader that meets a reference
   whose event row is missing fails loudly with the thread and seq; it never returns an empty
   item.
6. **Dictionaries are immutable once a row uses them**, are written in the same transaction as
   (or before) the first row that uses them, and are never shipped in the build: they are trained
   on this home's own rows, in an idle, bounded batch (ADR 0170), because a dictionary trained on
   one person's data carries their text. Until a kind has a dictionary, its rows are plain zstd
   frames (dictionary id 0).
7. **Turning the switch off changes no stored bytes**, and turning it back on resumes; nothing
   converts rows in either direction at open.

### 4.1 Read side and inventory

- Modules: a new `crates/ace-store/src/format/` (`mod.rs`, `body.rs` for the tagged body: one
  format byte, dictionary id as a varint, the zstd frame; `dictionaries.rs` for the table and an
  in-memory cache keyed by id), the `zstd` crate 0.13 (already chosen in ADR 0222 §2; check
  `deny.toml`), and a binding `decodeBody(bytes: Uint8Array, dictionary: Uint8Array | null):
  string` that returns the JSON text.
- TypeScript: one loader, `apps/daemon/src/stored-body.ts`, `storedPayload(row)` and
  `storedRevision(row)`, which every reader of a changed column calls instead of reading the JSON
  column. Readers to move (4.1 completes the list with
  `rg -n "payload FROM events|e\.payload|events\.payload|history_item_revisions" apps/daemon/src packages/search/src`):
  `bounded-events.ts`, `thread-reads.ts`, `search-replay.ts`, `long-thread/queries.ts`,
  `storage/transcript.ts`, `stored-trust-batch.ts`, `thread-fence.ts`, `engine/frame-envelope.ts`,
  `engine/handler.ts`, `engine/transition-history.ts`, `history-index.ts`,
  `history-message-replay.ts`, `history-search-replay.ts`, `stored-decode.ts`, `stored-shape.ts`,
  `stored-trust-rows.ts`, `draft-migration.ts`, `native-reads/long-thread.ts`, and the Rust reads
  in `crates/ace-store/src/reads/long_thread/`.
- Schema: `events.body BLOB`, `events.body_size INTEGER`, `history_item_revisions.body BLOB`,
  `history_item_revisions.ref_seq INTEGER` (NULL for a whole body), and
  `body_dictionaries(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, dictionary BLOB NOT NULL)`,
  added by `ALTER TABLE ... ADD COLUMN` and `CREATE TABLE IF NOT EXISTS` only.
- Proof: every (a) file in behaviour.md §15, with `ACE_STORE` off and on, on homes that have no
  format-2 rows: nothing may change. The read side is exercised by 4.2 and 4.3's runs.
- Bench: `sqlite-store.ts --split` before and after (reads must not slow on a format-1 home).

### 4.2 Write side: one body per revision (`refs`)

- Module: `history-index.ts` `record` (`:227`, the `INSERT INTO history_item_revisions` at
  `:142`). When the revision's item JSON equals the item in the event row written at the same
  seq (byte-equal text, compared before anything is stored), store the stub (rule 3), `ref_seq`,
  and no body. Plus every rewrite and removal path from rule 5.
- Proof, on and off: `history-storage.process.test.ts`,
  `history-publication-recovery.process.test.ts`, `stored-history-trust.test.ts`,
  `write-path-reads.test.ts`, `item-store-trusted-reads.test.ts`, `thread-delete.process.test.ts`,
  `thread-delete-crash.process.test.ts`, `thread-purge.process.test.ts`,
  `deleted-thread-recovery.process.test.ts`, `storage/data-retention.process.test.ts`,
  `storage/retention.process.test.ts`, `storage/compaction.process.test.ts`,
  `storage/recovery.process.test.ts`, `payloads.process.test.ts`, `migrations.process.test.ts`,
  the four `search-replay-*.process.test.ts`, `long-thread-lifecycle.process.test.ts`; then the
  cross-mode gate (written on, reopened off, and back).
- Bench: `sqlite-store.ts --split` (WAL pages per commit, database growth over the write phase),
  `event-writes.ts`.
- Failure modes: a crash between a revision and its event row (same transaction: both or
  neither); a purge batch boundary (rule 5); a restart with the switch flipped (rule 7); a
  reference read inside the open transaction that wrote it (one connection, so it sees the row).

### 4.3 Write side: compressed bodies (`zstd`)

- Modules: the `events` insert (`event-writer.ts`, the `INSERT INTO events VALUES` line, or
  `EventWriter::store_event` once task 5.3a has landed), `history-index.ts` record, the
  dictionary trainer in `crates/ace-store/src/format/train.rs` with an idle shell beside
  `stored-trust-pass.ts` (bounded batches, paused while writes run, resumable after restart).
- Kinds: one dictionary per event type for the five measured types (`item.updated`,
  `item.created`, `item.delta`, `thread.client.updated`, `agent.status`), one for revisions;
  everything else uses plain zstd level 3.
- Proof: as 4.2, plus `stored-trust-pass.test.ts`, `stored-trust-rows.test.ts`,
  `stored-trust-coverage.test.ts`, `stored-shape.test.ts`, `usage-replay.test.ts`,
  `wal-maintenance.process.test.ts`, `daemon-crash-recovery.process.test.ts`; cross-mode gate.
- Bench: as 4.2, and decode time per row on the read benches (ADR 0222 measured 0.4 to 3 µs).
- Failure modes: a dictionary row lost to a rolled-back transaction while a later row uses it
  (rule 6); training interrupted by shutdown (resumes; a half-trained dictionary is never used);
  a body over SQLite's limits (stays JSON).

### 4.4 Search: index long tool output up to 64 KiB (`search-cap`)

- Module: `packages/search/src/writer.ts` and `thread-writer.ts`, where bodies are handed to the
  trigram tables. Message and reasoning bodies stay whole; tool output and every other body is
  indexed up to its first 64 KiB of UTF-8, cut at a character boundary (never inside a UTF-16
  pair). Rows already indexed stay; nothing reindexes at open.
- Proof, on and off: `packages/search/src/search.process.test.ts`,
  `thread-search.process.test.ts`, `outputs.process.test.ts`, `pagination.process.test.ts`,
  `apps/daemon/src/search.outputs.process.test.ts` and the four `search-replay-*.process.test.ts`.
  One new test is allowed: a search for text past 64 KiB of a tool output finds nothing with the
  cap on (no test covers that behaviour today).
- Bench: index size (`dbstat` on the search tables) and in-thread search p50 from
  `sqlite-store.ts --split`, on a clone rebuilt with the cap on and off. Dropped if it saves less
  than a gigabyte there (owner's answer 2).

## Phase 5: the writer, as builder tasks

Five tasks, in this order, each its own PR on the writer branch, each reviewed before the next
starts: 5.1 the projection fold, 5.2 sequence reservation, 5.3 the event writer, 5.4 the live
buffer, 5.5 the transaction stack. Tasks 5.1 and 5.2 are small and self-contained; 5.3 to 5.5
are split into steps, and a step marked "needs a decision" is not briefed until the orchestrator
makes it.

What phase 5 does not do while TypeScript is the caller: move a loop whose body calls back into
TypeScript collaborators. Phases 1b and 3 measured that crossing values into JavaScript costs
more than it saves, so a loop moves to Rust only when everything it calls is Rust, or when the
Rust engine (ADR 0223 E5) is its caller.

Shared layout:

```
native/daemon/crates/ace-projection/        new: @ace/projection's daemon-side folds
  src/lib.rs                                 pub use thread::{update_thread, is_sidebar_event, FoldError}
  src/thread.rs
  tests/vectors.rs                           reads native/daemon/vectors/fold.json
native/daemon/crates/ace-store/src/writer/  new
  mod.rs
  sequences.rs                               5.2
  events.rs                                  5.3
  live/{mod.rs, compact.rs, buffer.rs, retry.rs}   5.4
  transaction.rs                             5.5
native/daemon/crates/ace-daemon-node/src/writer.rs  the binding for all of phase 5
native/daemon/vectors/fold.json             generated by scripts/store-vectors.ts
apps/daemon/src/native-writer/              the TypeScript shells, one file per task
```

### Task 5.1: the projection fold (`fold`)

**Port** `updateThread` and `isSidebarEvent` from `packages/projection/src/index.ts:164` to
`:235`, and nothing else from that package.

**Crate** `ace-projection` (depends on `ace-json` only; `ace-store` will depend on it):

```rust
#[derive(Debug)]                            // Display by hand: "event has no payload object"
pub enum FoldError { NoPayload }

/// `updateThread(thread, event)`: folds one canonical event into the thread, in place.
pub fn update_thread(thread: &mut ace_json::Map, event: &ace_json::Map) -> Result<(), FoldError>;
/// `isSidebarEvent(event)`.
pub fn is_sidebar_event(event: &ace_json::Map) -> bool;
```

**Semantics to keep, statement by statement** (the reviewer diffs the order against the TS):

1. `queue.updated`: `thread.queue` = the payload without `type`, keys in the payload's order.
   It replaces `queue` in place if present, else adds it at the end.
2. `thread.client.updated`: for each `[key, value]` of `payload.changes` in JavaScript order:
   `null` removes the key (`shift_remove`), anything else sets it (in place or appended).
   `__proto__` is an ordinary key here (the TS uses `defineProperty`).
3. `thread.updated`: the fields in exactly this order, each only when present in the payload:
   `workspaceId`, `permission` (copied), `backend` (then, if it is `"cursor-sdk"`, remove
   `continuation`), `capabilities`, `provider`, `lineage`, `delegatedBy`, `delegatedFrom`,
   `startedBy`, `startedByClient`, `treeRootId`, `queuedLaunch` (`null` removes), `execution`,
   `switch`, `title`, `titleSource`, `effectiveCapabilities`, `acpSupport`, `acp` (sets
   `acpAgentId`, `installationId`, `instanceId` in that order from `payload.acp`), `status` (set,
   then `activitySeq` = the event's `seq`), `archivedAt` (`null` removes), `goal` (`null`
   removes). A new key is appended when its statement runs, so two new keys land in statement
   order, not payload order.
4. `agent.created` whose `agent.origin` is `"root"`: `rootAgentId` = `agent.id`.
5. Last: if `is_sidebar_event` (`queue.updated`, `thread.created`, `thread.updated`,
   `thread.client.updated`), `updatedAt` = the event's `at`.
6. `structuredCopy` is `JSON.parse(JSON.stringify(x))`; on JSON input it is a deep clone, and
   `-0` prints as `0` either way. A `Value::clone` is the port. Unknown payload types fold
   nothing but rule 5.

**Binding** (`ace-daemon-node/src/writer.rs`): a method on `NativeDatabase`, because the shell
reaches the addon only through `nativeHandle(db)`; it does not touch the connection.

```rust
#[napi] impl NativeDatabase {
    /// `JSON.stringify(updateThread(thread, event))` for JSON texts of a thread and an event.
    #[napi] pub fn fold_thread(&self, env: Env, thread: String, event: String) -> napi::Result<String>;
}
```

Malformed JSON throws `SyntaxError` through `json_bind::syntax_error`; `FoldError` throws an
`Error` with its message.

**Shell** `apps/daemon/src/native-writer/fold.ts`:
`export function foldThread(db: DatabaseSync, thread: Thread, event: Event): void`. Off: calls
`updateThread`. On: `JSON.stringify`s both, calls `foldThread`, `JSON.parse`s the result and
replaces `thread`'s own keys in place (delete every own key, then define each parsed key in
order with `Object.defineProperty`, so `__proto__` stays an own key). The one call site is
`event-writer.ts:170` (`updateThread(thread, event)` becomes `foldThread(this.source.db, thread,
event)`). For `thread.created`, `thread` is `event.payload.thread` itself, so the fold also
changes the stored payload (its `updatedAt` becomes `event.at`); the in-place replace keeps that.
`status-store.ts:271` stays TypeScript (it folds the cached status view, which moves with 5.3).

**Vectors.** Move the `samples` table out of `canonical-event.test.ts` into
`apps/daemon/src/canonical-event-samples.ts` and import it back (a move: the test keeps every
assertion). `scripts/store-vectors.ts` builds `native/daemon/vectors/fold.json` from those
samples plus the cases below, running the TypeScript `updateThread` on `JSON.parse`d inputs, and
writes `{ thread, event, folded }` with `folded = JSON.stringify(result)`. `--check` regenerates
in memory and fails if the file differs; `scripts/check-daemon-native.ts` runs it.
`tests/vectors.rs` asserts `ace_json::to_string(folded thread) == folded`, byte for byte. Cases
that must be present (the reviewer counts them): every field of rule 3 alone, all of them
together on a thread that has none of them, each `null` removal, `cursor-sdk` with and without a
`continuation`, `status` (priority 1: a status fold that differs could show a working thread as
done), `acp`, `changes` with `null`, with `__proto__`, with an array-index key, and in an order
different from the thread's; `queue.updated` on a thread with and without `queue`; `agent.created`
root and non-root; strings with a lone surrogate and with a split pair; numbers `1e21`, `1.5e-7`,
`-0`, `2^53-1` in `seq` and `at`; an unknown payload type; a thread whose keys include an
array-index key.

**Proof, on and off:** `thread-columns.process.test.ts` (it folds with the TypeScript
`updateThread` and compares with what the store wrote, so with `fold` on it checks Rust against
TypeScript), `store.test.ts`, `thread-cache.process.test.ts`, `revision-triggers.process.test.ts`,
`sidebar-columns.test.ts`, `thread-row-trust.test.ts`, `store-held-view-rollback.test.ts`,
`status-storage.process.test.ts`, `long-thread-lifecycle.process.test.ts`. Off only (they never
load the addon): `packages/projection/src/projection.test.ts`, `settled-lifecycle.test.ts`,
`live-metadata.test.ts`, `snooze-wake.test.ts`, `snooze-woke.test.ts`, and
`apps/daemon/src/canonical-event.test.ts` after the move. Rust: `cargo test -p ace-projection`.

**Bench:** `event-writes.ts` on and off. Expect it slower (two `JSON.stringify` and a
`JSON.parse` per event); record it, don't turn it on. The fold pays off when the thread stays in
Rust (5.3c, E5).

**Do not:** import the addon in `packages/projection` (clients load that package); change
`updateThread`; use `serde_json`; add a Rust dependency other than `ace-json`; validate the event (canonical input is trusted, ADR 0125); write any other test.

**Reviewer checks:** statement order against the TS line by line; every vector case above is
present; `cargo test -p ace-projection` and `check:daemon-native` pass; the proof files pass in
all three modes; the bench numbers are in the PR.

### Task 5.2: sequence reservation (`sequences`)

**Port** `StreamSequences` (`apps/daemon/src/stream-sequences.ts`, all of it) to
`crates/ace-store/src/writer/sequences.rs`:

```rust
pub struct Sequences { cursor: Cursor, reserved: f64 }   // Cursor models the TS NaN case
impl Sequences {
    /// `SELECT seq FROM host_sequence WHERE id=1`. A missing row is not an error here: as in the
    /// TS (`Number(undefined)` is NaN), every later `next` fails with "Sequence exhausted".
    pub fn initialize(conn: &Connection) -> Result<Sequences>;
    pub fn reserved_through(&self) -> f64;
    /// Larger of MAX(events.seq) and MAX(usage_deletions.seq), 0 when both are empty.
    pub fn head(&self, conn: &Connection) -> Result<f64>;
    /// The TS rule: false past both head and reservation; true for 0, head, or a stored seq.
    pub fn replay_safe(&self, conn: &Connection, after: f64) -> Result<bool>;
    /// `cursor = max(cursor, after) + 1`; `SequenceError::Exhausted` past 2^53 - 1.
    pub fn next(&mut self, after: f64) -> Result<f64, SequenceError>;
    /// Pure: `None` when `after + events <= reserved`, else `Some(after + max(65536, events))`,
    /// or `Exhausted` when that is not a safe integer.
    pub fn reservation(&self, events: f64, after: f64) -> Result<Option<f64>, SequenceError>;
    /// Runs `UPDATE host_sequence SET seq=MAX(seq,?) WHERE id=1`. The caller holds the
    /// transaction that commits it; `reserved` does not change here.
    pub fn reserve(&self, conn: &Connection, through: f64) -> Result<()>;
    /// Records `reserved = through`, called only after that transaction committed.
    pub fn confirm_reserved(&mut self, through: f64);
}
```

Values are `f64` because they are JavaScript numbers on both sides until no TypeScript caller is
left; the safe-integer checks are where the TS has them. Statements go through `stmt_cache.rs`.

**Binding:** `NativeDatabase::sequences(&self) -> NativeSequences`, a `#[napi]` class holding the
`Arc<Connection>` and the `Sequences`, with one method per function above (`reserve` takes the
`through` that `reservation` returned). Non-finite or non-integral input throws `RangeError`.

**Shell** `apps/daemon/src/native-writer/sequences.ts`: `class NativeStreamSequences` with the
same public methods and constructor options as `StreamSequences`. `prepare(events, after)` asks
`reservation`; if it returns a value, runs `options.commit(() => native.reserve(through))`, then
`native.confirmReserved(through)`, then `options.reserved?.(through)`, in that order (the lineage mark hears of a range before any
sequence in it goes out, ADR 0128). The one call site is where `store.ts` constructs
`StreamSequences`.

**Invariants:** strictly increasing, never reused, every sequence inside a committed
reservation, reservation durable before use, `Sequence exhausted` past 2^53 - 1, head counts
deletion tombstones, a restart resumes from `host_sequence` (never below anything handed out).

**Proof, on and off:** `store.test.ts`, `sequence-lineage.test.ts`, `store-live-writes.test.ts`,
`store-live-write-recovery.test.ts`, `subscription-replay.test.ts`,
`history-storage.process.test.ts`, `history-publication-recovery.process.test.ts`,
`usage-replay.test.ts`, `thread-delete.process.test.ts`, `daemon-crash-recovery.process.test.ts`.
No new test.

**Failure modes:** a crash after a reservation commits and before its sequences are used leaves
a gap, which `replay_safe` already handles; a rolled-back reservation leaves `reserved`
unchanged, because only `confirm_reserved`, after the commit, records it.

**Do not:** keep a second cursor in TypeScript; open a transaction in Rust; change the SQL text;
change `host_sequence`'s format (old builds read it).

**Reviewer checks:** NaN/missing-row and exhaustion behaviour match; `reserved` changes only
after commit; proof files pass in all three modes; `event-writes.ts` on and off.

### Task 5.3: the event writer (`events`)

`EventWriter` (`apps/daemon/src/event-writer.ts`) is a loop over collaborators that are still
TypeScript: run-client preparation, decorations, `canonicalEvent`, live metadata, column encoding
with Zod, payload capping and tables, history revisions, status, the long-thread index, MCP data,
search. Per the rule above, the loop stays TypeScript; its own rows move first.

**Step 5.3a: the writer's own rows.** `crates/ace-store/src/writer/events.rs`:

```rust
pub struct EventWriter { /* cached statements only; no thread or event state */ }
pub struct NewThreadRow<'a> { id: &'a str, workspace_id: &'a str, title: &'a str, provider: &'a str,
    status_json: &'a str, created_at: f64, updated_at: f64, imported_json: Option<&'a str>, imported: bool }
pub struct EventRow<'a> { seq: f64, id: &'a str, thread_id: &'a str, at: f64, kind: &'a str, payload_json: &'a str }
impl EventWriter {
    /// `workspace_unregistered` check, `INSERT INTO threads`, and `workspace_recent` unless imported.
    pub fn create_thread(&mut self, conn: &Connection, row: &NewThreadRow) -> Result<(), WriteError>;
    /// `INSERT INTO events VALUES (?,?,?,?,?,?)` then `UPDATE host_sequence SET seq = MAX(seq,?)`.
    pub fn store_event(&mut self, conn: &Connection, row: &EventRow) -> Result<(), WriteError>;
}
```

The SQL text is copied from `event-writer.ts` unchanged. `at` in `EventRow` is the append's `at`
argument, as the TS stores it, not `event.at`. `payload_json` is the TypeScript's
`JSON.stringify(event.payload)` after capping, stored as given. `WriteError::WorkspaceUnregistered`
carries the message `workspace_unregistered`. Binding: `NativeDatabase::event_writer()`, a class
with `createThread(...)` and `storeEvent(...)`. Shell: in `event-writer.ts`, the two blocks
(`thread.created` insert, `events` + `host_sequence`) each become one `if (storeWriterOn("events"))`
call into `apps/daemon/src/native-writer/events.ts`. The `Invalid thread creation` and `Unknown
thread` checks stay in the TypeScript.

Proof, on and off: `store.test.ts`, `stored-shape.test.ts`, `thread-columns.process.test.ts`,
`thread-cache.process.test.ts`, `revision-triggers.process.test.ts`, `sidebar-columns.test.ts`,
`store-auto-rollback.test.ts`, `store-live-writes.test.ts`, `payloads.process.test.ts`,
`history-storage.process.test.ts`, `status-storage.process.test.ts`,
`long-thread-lifecycle.process.test.ts`, `engine/storage-behaviour.process.test.ts`,
`daemon-crash-recovery.process.test.ts`, `projects` tests that cover `workspace_recent` (find them
with `rg -l workspace_recent apps/daemon/src --glob '*.test.ts'`). Bench: `event-writes.ts` and
`sqlite-store.ts --split` (commit p50, WAL pages per commit). Failure modes: a failure in
`store_event` after collaborators wrote rows rolls back with them (one transaction); a
duplicate id or seq throws SQLite's constraint error unchanged (`isStoreBusy` and retry logic
branch on `errcode`).

**Step 5.3b: thread column writes (needs a decision).** `writeThread` and `threadColumnChanges`
(`thread-columns.ts`) encode columns with `ThreadClientColumn.parse`, `ThreadDetails.parse` and
`ThreadProviderMetadata.parse`. Porting them means reproducing Zod's stripping and defaults for
those schemas in Rust, which the "Rust fetches, TypeScript shapes" decision (ADR 0222) forbids
unless the generated `ace-protocol` types can do it, pinned by vectors. The orchestrator decides
before this is briefed.

**Step 5.3c onward: collaborators, then the loop.** In this order, each a later task:
`canonicalEvent` (its samples become vectors, behaviour.md §15), decorations, payload capping
and tables (`payload-store.ts`), history revisions (`history-index.ts`), status
(`status-store.ts`, including its `updateThread` call), the long-thread index, MCP data, run
client and live metadata, search notification. When each has a Rust implementation, the loop
(`EventWriter.write`) moves, with a `Derive` trait for any collaborator still TypeScript only if
E5 is the caller.

### Task 5.4: the live buffer (`live`)

**Step 5.4a, pure parts.** Port `compactDeltas` (`live-write-buffer.ts:204`) to
`writer/live/compact.rs` and `liveWriteRetry`/`liveWriteRetryDelay` (`live-write-retry.ts`) to
`writer/live/retry.rs`:

```rust
/// Adjacent `item.delta` events of one thread, item, agent and field merge into one row while
/// the UTF-8 bytes of both appends total at most 4096. Inputs are not changed.
pub fn compact_deltas(events: &[ace_json::Map]) -> Vec<ace_json::Map>;
pub const RETRY: Retry = Retry { base_ms: 100, cap_ms: 5_000, quarantine_after: 6 };
pub fn retry_delay(failures: u32) -> u64;
```

The merged row is the later event's envelope, with the later payload whose `append` is replaced
in place by `earlier + later` (key position kept). Bytes are counted as `Buffer.byteLength`
counts them (a lone surrogate is 3 bytes). The concatenation joins UTF-16 units, so a pair split
across two deltas becomes one character, and the 4 KiB check is made on the two parts as the TS
makes it (sum of the two counts, not the count of the joined string).

**Step 5.4b, the buffer state.** Port `LiveWriteBuffer`'s bookkeeping (weights, the 64 KiB
flush-now rule, the 8 MiB ceiling, the 75 ms and 1 s deadlines, `begin`/`committed`/`rearm`/
`retry`) to `writer/live/buffer.rs`, holding sequences and sizes, not event objects. The buffer
returns deadlines; the shell schedules them on the owning thread between JavaScript turns, never
inside an open transaction (ADR 0222 §3). `StoreStream` (`store-stream.ts`) stays TypeScript
until 5.5: it calls the transaction, `persist`, `append` and `publish`.

Shell `apps/daemon/src/native-writer/live.ts`, selected where `store-stream.ts` constructs the
buffer and calls `compactDeltas`.

Proof, on and off: `store-live-writes.test.ts`, `store-live-write-recovery.test.ts`,
`engine/live-write-buffer.process.test.ts`, `engine/live-write-quarantine.process.test.ts`,
`engine/storage-behaviour.process.test.ts`, `subscription-tail.test.ts`,
`text-storage.process.test.ts`, `daemon-crash-recovery.process.test.ts`,
`shutdown-deadline.process.test.ts`. Vectors: add `compact` cases to `fold.json`'s generator
(split pairs, lone surrogates, exactly 4096 and 4097 bytes, different agent or field, other
threads interleaved). Bench: `live-write-buffer.ts`, `allocation-rate.ts`.

Failure modes: a crash with buffered output loses only rows nobody saw as stored (replay of a
published-but-unstored cursor is refused by `replay_safe`, behaviour.md §11); a flush sealed
inside an open transaction is written once after rollback and never after commit; a retry
treats rows an earlier attempt committed (same seq and id) as stored; contention and a full disk
never count toward quarantine.

Do not: own a timer or thread in Rust; compact the held suffix; change the 4 KiB, 64 KiB, 8 MiB,
75 ms, 1 s, 100 ms, 5 s or 6 constants.

### Task 5.5: the transaction stack (`transactions`)

**Port** the stack in `store.ts` `transaction` (`:567` to `:700`): depth, numbered savepoints,
`BEGIN IMMEDIATE`, `RELEASE`, `recoverSavepoint`, the doomed flag, `rollBack`, settlement
positions and the publication order, to `writer/transaction.rs`. JavaScript closures cannot run
inside a Rust call, so the API is begin/finish, and the closure form is built on it for Rust
callers:

```rust
pub struct TransactionStack { depth: u32, events: Vec<Published>, settlements: Vec<Settlement>, doomed: Option<Error> }
pub struct Frame { depth: u32, savepoint: Option<String>, events_len: usize, settlements_len: usize }
pub enum Finish { Released, Committed(Publication), RolledBack { generation_bump: bool } }
/// The order the caller runs after COMMIT: publish events[a..b], settle settlement i, ...
pub struct Publication(pub Vec<Step>);
pub enum Step { Publish { from: usize, to: usize }, Settle { index: usize, committed: bool } }
impl TransactionStack {
    pub fn begin(&mut self, conn: &Connection) -> Result<Frame>;
    pub fn succeed(&mut self, conn: &Connection, frame: Frame, outcome: Option<SettlementId>) -> Result<Finish>;
    pub fn fail(&mut self, conn: &Connection, frame: Frame) -> Finish;   // never throws; failures are reported in Finish
    pub fn atomic<T>(&mut self, conn: &Connection, run: impl FnOnce(&Connection) -> Result<T>) -> Result<(T, Finish)>;
}
```

The TypeScript `Store.transaction` keeps everything that is a TypeScript object: the thread
cache, read caches, sidebar invalidation, the WAL wake, the `Promise` check (`Store transactions
must be synchronous`), the history-installation inline path, and running the `Publication`
steps. Shell: `apps/daemon/src/native-writer/transaction.ts`, selected inside `transaction`.

**Invariants** (behaviour.md §4): live writes flush before any transaction; publication only
after `COMMIT` returns, in sequence order, interleaving settlements in nesting order; nothing at
or below `publishedSeq` republished; a nested failure rolls back to its savepoint and rethrows; a
savepoint that cannot be undone dooms the outer transaction; any rollback bumps
`rollbackGeneration`; a failed `ROLLBACK` is reported and the caller's own error is thrown.

**Proof, on and off:** `store.test.ts`, `store-auto-rollback.test.ts`,
`store-held-view-rollback.test.ts`, `store-live-write-recovery.test.ts`,
`store-read-cache.test.ts`, `thread-cache.process.test.ts`, `sidebar-columns.test.ts`,
`payloads.process.test.ts`, `history-storage.process.test.ts`,
`history-publication-recovery.process.test.ts`, `wal-maintenance.process.test.ts`,
`daemon-crash-recovery.process.test.ts`, `storage/recovery.process.test.ts`. Bench:
`sqlite-store.ts --split` (commit p50 and p95), `event-writes.ts`.

**Failure modes:** `SQLITE_FULL` or an I/O error that rolls the transaction back inside a
savepoint (`is_transaction` false afterwards); a crash mid-transaction (WAL frames uncommitted,
nothing published); a throw from a settlement callback (reported, the transaction stays
settled).

**Placement:** when no TypeScript calls `Store.atomic` any more (ADR 0223 §4), the stack and
the connection move to one core thread; `TransactionStack` is unchanged and only the binding is
replaced.

## Reviewing a phase 5 task

1. The diff touches only the files in the brief.
2. The Rust follows the TypeScript statement by statement; the reviewer reads both side by side.
3. Every JS-visible value is `ace-json`; no `serde_json::Value`, no `String` for JS strings, no
   hand-formatted numbers, no sorted keys.
4. No `unwrap`, `expect`, `panic!`, recursion over values, thread, timer, clock or global.
5. Vectors regenerate unchanged (`bun scripts/store-vectors.ts --check`).
6. Every proof file passes in all three modes, run one at a time, and the PR lists them.
7. Bench numbers on and off are in the PR; the part stays off unless they are no worse.
8. `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test` and
   `bun run check:daemon-native` pass.
