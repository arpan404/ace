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
9. **The switch.** `ACE_STORE_WRITER`, a comma list of `fold`, `sequences`, `events`, `columns`,
   `live`, `transactions` (`columns` is step 5.3b-2's part), read once in
   `packages/provider-kit/src/native-switches.ts` next to `ACE_GIT` (export `storeWriterOn(part)`
   and `storeWriterParts()`), off by default. It needs `ACE_STORE=native` and refuses to start
   without it, and each part refuses to start without the parts before it in that list. Like `ACE_STORE` it takes its value once per process, at
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

11. **Every call into the addon goes through the SQLite error translator.** The addon throws
    `ace-store:{...}` errors that `packages/provider-kit/src/native-sqlite.ts` turns into the
    errors node:sqlite throws (`rethrow`, `:82`; `call`, `:102`), with `errcode` and `errstr`.
    Retry and busy handling branch on those (`isStoreBusy`, `isStoreRetry`, `store-busy.ts`), so
    a shell that calls a binding method directly loses them. The first task that adds a shell
    exports `call` from `native-sqlite.ts` as `nativeCall` (re-exported from
    `@ace/provider-kit/sqlite`), and every shell call into the addon is
    `nativeCall(() => handle.method(...))`. In Rust, SQLite failures leave the binding through
    `fail()` (`ace-daemon-node/src/lib.rs`), never as a bare message; writer errors that are not
    SQLite's (`WorkspaceUnregistered`, `Exhausted`, `FoldError`) throw a plain `Error` with the
    TypeScript's message.

## Phase 4: the storage format

ADR 0222 §6 steps 1 and 2, and the search cap from the owner's answer 2. Each step changes rows
written after it ships; old rows stay as they are, and nothing history-sized runs at open
(ADR 0170). Recompression of old rows and cold storage are later work with their own switches
(owner's answers 3 and 4) and are not part of phase 4.

Two releases matter. **Release R** ships the read side (4.1): the schema step, the format-aware
readers and writers, and the codec. It writes no format-2 row whatever the switch says. **R+1
or later** may write format-2 rows, and only with the switch on. Nothing in 4.2 to 4.4 merges
until R has shipped.

Switch: `ACE_STORE_FORMAT`, a comma list of `refs` (4.2), `zstd` (4.3) and `search-cap` (4.4);
ADR 0222's `ACE_STORE_FORMAT=2` means `refs,zstd`. It switches the write side only. The read
side has no switch: from R on, every build reads both formats.

Terms used below. A **body column** is `events.payload` or `history_item_revisions.item`. A
**row kind** is an event `type`, or a revision's item `type`. The **logical body** is the JSON
text a format-1 row stores in its body column. The **stub** is the small JSON object a format-2
row keeps in its body column for SQL (rule 4). The **logical size** is the UTF-8 byte length of
the logical body (what `octet_length(<body column>)` returns for a format-1 row). The **stored
size** is the bytes the row takes on disk.

### 4.0 The rollback contract (write and review this before any code)

ADR 0222 §7 requires it first. The builder of 4.1 copies each rule below into
`docs/store/format-inventory.md` as a checklist entry with the code that meets it, and the
reviewer signs every entry off before 4.2 starts.

1. **Readable with the switch off, through every path.** A build from R on, with the format
   switch off, reads every format-2 row through the `Store` methods, the Rust reads
   (`crates/ace-store/src/reads/`), and direct SQL in `atomic` callers. This holds with
   `ACE_STORE` off too: decoding is a pure addon function that opens no SQLite, so a
   node:sqlite store can call it without breaking the one-SQLite-per-file rule (ADR 0222,
   constraint 2).
2. **A constant-time codec check before serving a format-2 home.** R adds
   `storage_format(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)`. The first
   format-2 row is written in the same transaction that inserts this row. At open, right after
   `migrate`, the store reads it with one primary-key lookup. If it exists, the store calls the
   addon's `bodyCodecVersion()` and refuses to open (`IncompatibleDataError`, naming the addon
   path) when the addon is missing or its version is lower. It never falls back to reading stubs.
3. **Builds older than R refuse the home, and R's own writes keep working.**
   - `migrate` refuses a newer `schema_version` (`migrations.ts:221` to `:235`:
     `version > migrations.length` throws `IncompatibleDataError`). It runs every step and the
     version bump in one `BEGIN IMMEDIATE` transaction, so the step and the bump land together.
   - R adds one migration step, written so it works on fresh and existing homes alike. Not every
     changed table exists when `migrate` runs: `events` is created by an earlier step
     (`migrations.ts:31`), but `history_item_revisions` is created later, by the `HistoryIndex`
     constructor (`store.ts:328`, `history-index.ts:89` to `:102`), so on a fresh home it does
     not exist yet. For each changed table, the step looks the table up in `sqlite_master`. If
     the table exists, the step reads `PRAGMA table_info` and runs
     `ALTER TABLE <t> ADD COLUMN <c> <type>` for each new column it lacks (so running it twice is
     harmless). If the table does not exist, the step does nothing for it, and the table's
     creator gets the new columns: `history-index.ts`'s `CREATE TABLE IF NOT EXISTS
history_item_revisions` lists them last, in the same order the `ALTER`s add them, so both
     paths give the same columns in the same order. New tables (`storage_format`,
     `body_dictionaries`, `body_dictionary_sources`) and their indexes are created by the step
     with `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`; they are empty, so this
     costs nothing.
   - Every new column on an existing table is nullable, with no default, no `CHECK`, no
     `REFERENCES`, no `UNIQUE` and no `PRIMARY KEY`, and is not generated. SQLite then adds it by
     rewriting the schema only: no row is read and no index is rebuilt (ADR 0170). A `CHECK` or
     a `NOT NULL` column would make SQLite test existing rows. No index is created on an existing
     table.
   - In the same release, before the step is added, every positional insert into a changed table
     becomes a named-column insert, in both writer modes: `event-writer.ts:180`
     (`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)` becomes
     `INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (?, ?, ?, ?, ?, ?)`),
     `history-index.ts:142` (`INSERT INTO history_item_revisions VALUES (?,?,?)` becomes
     `(item_id, seq, item)`), task 5.3a's Rust, and every other match of
     `rg -n "INSERT (OR [A-Z]+ )?INTO \"?(events|history_item_revisions)\"? *(VALUES|SELECT)" apps packages native`.
   - Release gate, a manual check on a throwaway `ACE_HOME` (never `~/.ace` or a copy of it). An
     older build sets pragmas before it reads the schema, then closes the connection when it
     refuses (`store.ts:272` to `:291`, `:440` to `:442`). Closing the last connection may
     checkpoint and remove the WAL and SHM files, so file hashes prove nothing. The gate checks
     logical contents instead:
     1. With the R+1 build and the switch on, write format-2 rows with the scripted provider, then
        `kill -9` the daemon before any checkpoint.
     2. Prove the format-2 commit is only in the WAL. `cp -c` all three files to scratch
        directory A, and `events.sqlite` alone (no `-wal`, no `-shm`) to scratch directory B.
        `sqlite3 -readonly` finds the `storage_format` row in A and not in B.
     3. Record the logical contents from A: with the R+1 build, open A with a `Store` (not a
        daemon) and hash every event `readEvents` returns from seq 0, in order, plus every
        revision `readHistorical*` returns for each thread.
     4. Open the original home with the last build before R. It must refuse with "newer than
        this build's" and exit non-zero.
     5. Open the original home with the R+1 build. It opens, the `storage_format` row is there,
        and the hashes from step 3 are equal.
     6. Delete A, B and the throwaway home.
4. **SQL that looks inside a body keeps working, within the bounds it has today.** 4.1a lists
   every consumer of a body column, per row kind, in `docs/store/format-inventory.md`. Find them
   with
   `rg -n "json_extract|json_type|json_each|json_tree|json_set|json_group_array|json_array_length|->>|->|octet_length|length\(CAST" apps packages native --glob '!*.test.ts'`,
   then read each hit. Much of this SQL is built at runtime from helpers (for example
   `field(path)`, `optional(...)`, `asks` and `skills` in `usage-replay.ts:20` to `:109`), and
   the inventory records the expanded paths, not the helper. Also list every TypeScript or Rust
   reader that reads a whole body column, and every reader that keeps a byte bound by measuring
   or slicing a body inside SQL. Classify each consumer:
   - **F (fixed paths):** reads named scalar or object paths only. Known so far: the
     `json_extract` and `json_type` paths of `usage-replay.ts:20` to `:109` (usage and session
     counters, `usageScope`, `delegatedBy`, `delegatedFrom`, `startedBy`, the ask test on
     `item.type`, `item.role`, `item.synthetic`, `item.inherited`, `item.origin.kind`,
     `item.origin.role`), `search-replay.ts:53` (`thread.id`, `thread.workspaceId`,
     `thread.provider`, `thread.createdAt`, `thread.updatedAt`, `thread.status`, `status`, and the
     rest of that statement), `draft-migration.ts:12` (`type`, `role`, `synthetic` on `items` and
     revisions), `engine/handler.ts:419`, `engine/transition-history.ts:45`, and the partial index
     `history_completed_revisions` (`history-index.ts:102`, `$.complete`).
   - **A (array walk):** walks one array with `json_each`, reading named paths off each element.
     Known so far: `usage-replay.ts:56` to `:60` (the skill names: `json_each(payload,
'$.item.parts')`, reading `$.type`, `$.kind` and `$.name` of each part). An A consumer is
     served by an **array projection** in the stub: the array keeps every element, in order (so
     `json_each`'s keys, the ordinals, are the same), and each element is cut down to the paths
     the consumer reads off `part.value`, a path absent from an element staying absent.
   - **W (whole body, computed paths, or a byte bound kept in SQL):** walks the body, builds paths
     from data, or measures or slices a body in SQL so as not to materialise it. Known so far:
     `history-search-replay.ts:43` to `:69` (`json_tree(r.item)` over revisions of every item
     type, slicing large leaves as BLOBs before they reach JavaScript), which `history-index.ts:190`
     to `:205` routes every revision larger than the budget to; and `history-message-replay.ts:16`
     to `:24` (`json_each` over `$.parts` with part ordinals and `$.source` objects).
     A row kind may be written in format 2 only when every consumer of it is F or A with all its
     paths in the stub. A W consumer is never served by decoding a whole row: decoding an oversized
     revision, or the larger event a reference points at, would materialise on the daemon thread
     exactly what the SQL slicing avoids. So **every revision stays format 1 in phase 4** (no
     references, no compression). Revisions move only after a later task gives the W consumers a
     bounded reader: one that reads `body_size` first and, over the budget, decodes with streaming
     zstd and slices leaves without holding more than today's bound. That task is not part of this
     guide. The stub is a JSON object holding exactly the union of the kind's F paths and A
     projections, values copied unchanged, keys in the order the logical body has them, nested
     objects cut down to the paths needed. A path absent from the body is absent from the stub, so
     `json_type(...) IS NULL` answers the same. A kind whose stub would be more than half its
     logical body stays format 1.
5. **Sizes.** Every format-2 row stores its logical size in `body_size`, computed from the
   logical body before anything is stored. In phase 4 only `events` has format-2 rows (rule 4),
   but `history_item_revisions` gets the column in R too, so the revision task needs no second
   schema step; there, a reference's `body_size` is the logical size of the revision it stands
   for. Every query that measures a body for a budget, a page or a trust batch reads
   `coalesce(body_size, octet_length(<column>))` in place of the bare expression, and keeps the
   terms around it: `bounded-events.ts:37` (`+ octet_length(id) + octet_length(thread_id)`),
   `history-index.ts:191` (`length(CAST(item AS BLOB))`, the history budget),
   `stored-trust-batch.ts:83` (each statement), `search-replay.ts:50`, and every other size hit
   from rule 4's search.
   Stored-size accounting is separate and never stands in for a logical size.
   `storage/transcript.ts:63` to `:89` (`transcriptQueries`) sums stored bytes per thread. Its
   automatic per-column sum covers only tables with a `thread_id` column, so it never counts
   `history_item_revisions` today. R adds them without one long statement. A single `SUM` over a thread's
   revisions runs as one synchronous call, however many there are, and `transcriptBytes`
   (`storage/transcript.ts:99`) yields only between statements. So revisions are summed in batches by key: `transcriptBytes` gains a second kind
   of entry, a batched measurement, which runs short statements with a cursor and yields
   (`setImmediate`) and checks `going()` between them. Two statements, each bounded by its
   `LIMIT` and an index:

- items: `SELECT rowid, id, created_seq FROM history_items WHERE thread_id = ?1 AND (created_seq, rowid) > (?2, ?3) ORDER BY created_seq, rowid LIMIT 64`
  (the `history_items_creation` index on `(thread_id, created_seq)` holds the rowid, so this is
  index order with no sort);
- revisions of one item: `SELECT seq, octet_length(item) + COALESCE(octet_length(body),0) AS bytes FROM history_item_revisions WHERE item_id = ?1 AND seq > ?2 ORDER BY seq LIMIT 512`
  (the primary key).

It pages items 64 at a time, and for each item pages its revisions 512 at a time, yielding
between statements. The builder checks both with `EXPLAIN QUERY PLAN`: no `SCAN` of either
table and no `USE TEMP B-TREE`. The inventory's caller
(`storage/inventory.ts:47`, `measure`) is unchanged. The `events` query adds `COALESCE(octet_length(body),0)`. The revision batches change
today's numbers, so they are their own commit, with `storage/data-retention.process.test.ts`,
`storage/retention.process.test.ts`, `storage/space-reclaim.process.test.ts` and
`storage/transcript-indexes.process.test.ts` run with it. If any fails because the totals
moved, stop and report.
Diagnostics (`packages/diagnostics/src/thread-worker.ts:22`) decode a format-2 row through
the addon and apply the 60,000-byte cap to the logical size. When the addon cannot be loaded,
they emit `"<ENCODED EVENT OMITTED>"`. They never emit a stub as if it were the payload. 6. **One function changes a body, and trust follows it.** `rewriteStoredBody(db, table, key,
   logicalJson, origin)` in `apps/daemon/src/stored-body.ts`, and `format::rewrite` in Rust for
Rust callers, do all of this in the caller's transaction:

- (a) materialise the references to the old body (rule 7);
- (b) write the new stub, `body`, `body_size`, format tag and dictionary id together, or the
  plain JSON with those columns NULL for a format-1 row;
- (c) trust. `origin` is `"validated"` when `logicalJson` was serialised from a value this
  build parsed or built (trust is unchanged, ADR 0125), and `"raw"` otherwise. For `"raw"`,
  the rewritten row's seq is rejected in two places. Persisted: `INSERT OR IGNORE INTO
stored_event_rejected VALUES (?)`, one row per rewritten seq, which commits or rolls back
  with the rewrite. Live: the store's in-memory `StoredTrust` (`trust.rejected`, the set
  `readStoredTrust` loads, `stored-shape.ts:225` to `:236`) gets the seq at once, so a read
  inside the same transaction validates the row. The store records each live addition in a journal
  (`trustJournal: number[]`, the seqs it added that were not in the set before). It does
  not use a `TransactionOutcome` for this: a failing frame's own outcome is never called
  back (`store.ts:601` to `:612` settle only the settlements registered inside the frame,
  and `:637` only the nested ones). Instead, the store undoes the journal explicitly at
  both failure points. In the savepoint catch (`store.ts:601` to `:612`), it removes the
  seqs journalled since that savepoint began (journal length kept at `SAVEPOINT`). In the
  top-level catch (`store.ts:637`), it removes every journalled seq. After `COMMIT`
  returns, it clears the journal. In 5.5 the shell does the same, from `Finish.ending`.
  Rejecting too much only costs a validation; rejecting too little
  is the bug. Rejection is by seq, so it covers every row at that seq, events and revisions
  alike, which `stored-trust-rows.ts:38` to `:59` maps by `(seq, kind, item_id)`. A second
  connection (the history publication worker) reloads with `readStoredTrust` as it does today.
- `forgetStoredTrust` (`stored-shape.ts:269`) stays for bulk raw rewrites at open, before
  `openStoredTrust`, as `permission-mode-migration.ts:33` uses it. It is never called at
  runtime, because it would clear persisted trust while the live set stays as it was.
  No other code updates a body column. Each raw rewrite that exists today either gets a written
  proof in the checklist that it can only run on a home with no format-2 row, or is converted
  to `rewriteStoredBody`. The proof is: its marker is written on every home at or before R, and
  a fresh home runs it at creation, before any row exists. The two known rewrites are
  `payload-store.ts:139` (`UPDATE events SET payload`, marker `payload_migration`) and
  `permission-mode-migration.ts:38` (`json_set` over `payload`, marker in `upgrade_cleanup`). A
  rewrite that cannot be proven safe this way is converted. Review rejects any new raw update of
  a body column; find them with
  `rg -n "UPDATE \"?(events|history_item_revisions)\"? SET" apps packages native`.

7. **References and deletes.** A reference revision stands for the item in the event row with
   the same seq and the same thread, whose payload is `item.created` or `item.updated` of the
   same item id. From an event to its references is one primary-key lookup on
   `history_item_revisions(item_id, seq)`, with `item_id` read from the event's stub
   (`$.item.id` is therefore an F path of both kinds). Never scan revisions per event (ADR 0170).
   The removal paths:
   - `deleteThread` (`store.ts:1412`) deletes the thread's events and its `threads` row in one
     transaction. Its revisions go by cascade
     (`threads` → `history_items` → `history_item_revisions`, `history-index.ts:93`, `:98`), so
     nothing needs materialising.
   - `purgeThreadData` (`store.ts:1405`) runs the generated plan
     (`storage/transcript.ts:187` `transcriptPurgePlan`, batches at `:282`, the last step at
     `:298`). The plan deletes owned rows, revisions included, before events (its step 3 is
     last), so the purged thread's references go before the rows they point at, and nothing
     needs materialising. The builder confirms this order for `history_item_revisions` from the
     plan the code generates (including after a crash between batches, when only references
     whose event rows still exist may remain) and writes the proof in the checklist.
   - Every other statement that deletes or rewrites an event row, literal or generated from
     `sqlite_master` (search `storage/transcript.ts`, `storage/compaction.ts`,
     `storage/data-retention.ts`, `storage/apply.ts` and the rest of rule 4's search), first
     materialises the references that survive it, by primary-key lookup, in the same
     transaction, through rule 6's function.
     A reader that meets a reference whose event row is missing throws an error naming the thread
     id and seq. It never returns an empty or partial item.
8. **Dictionaries.** R creates:
   - `body_dictionaries(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dictionary BLOB NOT NULL, retired INTEGER NOT NULL DEFAULT 0)`,
     with `CREATE INDEX body_dictionaries_active ON body_dictionaries(kind, id) WHERE retired = 0`
     for the active-kind lookup (newest non-retired id of a kind);
   - `body_dictionary_sources(dictionary_id INTEGER NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY(dictionary_id, thread_id)) WITHOUT ROWID`,
     with `CREATE INDEX body_dictionary_sources_thread ON body_dictionary_sources(thread_id)` for
     retirement by source thread.

   The rules:
   - `AUTOINCREMENT` makes ids fresh and never reused in this database, even after a delete. An
     id means something only in the database that holds it: a frame's id is resolved against
     that database's table, through a cache owned by that connection, never a process-wide one.
   - A dictionary's bytes never change. Which dictionary a kind writes with is the newest
     non-retired id of that kind, so a kind can change dictionaries without changing what any
     existing id means.
   - Phase 4 deletes no dictionary: its bytes stay while any frame might use them. Deletion
     comes with recompression (owner's answer 4).
   - **The write selection** (kind → dictionary id), cached per connection, changes only at
     commit. A transaction that installs or retires a dictionary marks the selection stale for
     the kinds it touched. For the rest of that transaction, writes of those kinds use plain zstd
     (id 0). After `COMMIT` returns, the selection reloads those kinds. On rollback, the marks
     clear and nothing reloads. The decode cache takes a dictionary only after the transaction
     that inserted it has committed.
   - **Training** (4.3b) samples only threads that are not deleted, not tombstoned
     (`thread-gone.ts:54` to `:59` writes the tombstone as a `deletedAt` change) and not host
     threads (ADR 0121). It draws from at most 256 source threads per dictionary. It runs in
     idle batches bounded by rows (2,000), sample bytes (8 MiB) and time (50 ms per batch),
     pauses while writes run (ADR 0170), and keeps the source thread ids in memory.
   - **Installation** is one transaction, bounded by the 256 sources. For each source it makes
     three primary-key lookups and no scan. First, the `threads` row exists, read
     unenriched by one statement on its primary key, never through `readThread`, which can
     resolve up to 32 ancestors (`tree-root.ts:69` to `:89`):
     `SELECT json_extract(client,'$.deletedAt') AS deleted, json_extract(client,'$.host') AS host FROM threads WHERE id = ?`
     (both fields live in the `client` column, `thread-columns.ts`; the builder confirms
     this), and both are NULL. Then there is no `thread_purges` row and no
     `storage_purged` row (both keyed by `thread_id`, `storage/journal.ts:34`). It does not
     probe `usage_deletions`, whose only key is `seq` (`migrations.ts:115`): every deletion that
     leaves a `usage_deletions` row also sets `deletedAt`, removes the `threads` row, or
     starts a purge, which the three lookups see. If any source fails, the transaction
     inserts nothing, and training starts again later from new samples; a source tombstoned
     between sample batches (`thread-gone.ts:88` to `:105` purges in many transactions) is
     caught here. Otherwise it inserts the dictionary and its `body_dictionary_sources` rows,
     **retires the kind's previous active dictionary and deletes that dictionary's source
     rows**, and marks the selection stale. So a kind has at most one active dictionary, and a
     thread has at most one source row per kind (six kinds today).
   - **Retirement at the tombstone's commit.** One function,
     `retireDictionariesOf(db, threadId)`, retires the dictionaries that thread sourced and
     deletes their source rows:
     `UPDATE body_dictionaries SET retired = 1 WHERE retired = 0 AND id IN (SELECT dictionary_id FROM body_dictionary_sources WHERE thread_id = ?1)`,
     then `DELETE FROM body_dictionary_sources WHERE dictionary_id IN (<the ids it retired>)`,
     and marks the selection stale. Since only active dictionaries keep source rows, it visits
     at most one row per kind. It runs in the same transaction as every event that sets a
     thread's `deletedAt` (a write hook, `Store.onWrite`, that checks the batch's
     `thread.client.updated` changes), and in `deleteThread`, `purgeThreadData` and retention.
     A retired dictionary keeps decoding the frames that already use it. Its bytes keep
     fragments of its source threads until recompression rewrites those frames; the 4.3b PR
     states this limit in its description.
   - A copy of the database (backup, clone) carries dictionaries as it carries rows. An export
     that leaves transcripts out (diagnostics, triage bundles) also leaves `body_dictionaries`
     out. Find the export paths with
     `rg -n "events\.sqlite|\.backup\(|VACUUM INTO" apps packages tools`.
   - Until the reviewer signs off this rule's checklist, no dictionary is trained on a real
     home: frames are plain zstd (dictionary id 0). Tests and benches train on throwaway homes.

9. **Turning the switch off changes no stored bytes**, and turning it back on resumes. Nothing
   converts rows in either direction at open.

### 4.1 Release R: the read side

**4.1a Inventory.** `docs/store/format-inventory.md`: every consumer from rule 4 with its class
and expanded paths, every size query from rule 5, every rewrite and delete from rules 6 and 7
(literal and generated), every export from rule 8, and the stub path list per row kind. Docs
only; reviewed before 4.1b.

**4.1b Code.**

- Rust: `crates/ace-store/src/format/` with `mod.rs`, `body.rs` (the tagged body: one format
  byte, the dictionary id as a varint, the zstd frame), `stub.rs` (stub from logical body and a
  path list), `dictionaries.rs` (the table and the per-connection cache of rule 8) and
  `rewrite.rs` (rule 6). Dependency: `zstd` 0.13 (ADR 0222 §2), checked against `deny.toml`.
- Binding: `decodeBody(bytes: Uint8Array, dictionary: Uint8Array | null): string` (the logical
  JSON text) and `bodyCodecVersion(): number`, both pure, needing no connection.
- TypeScript `apps/daemon/src/stored-body.ts`: `storedPayload(row)`, `storedRevision(row)`,
  `rewriteStoredBody(...)`, and `logicalSize(column)`, the SQL fragment of rule 5. Every reader
  of a body column from 4.1a calls them in place of reading the column.
- The schema step (rule 3), named inserts (rule 3), the open-time check (rule 2), the size
  queries (rule 5), the diagnostics change (rule 5).
- The W consumers are not changed in R. They keep reading format-1 revisions, which is all
  phase 4 writes (rule 4).

Proof, with `ACE_STORE` off and on, on homes with no format-2 row (nothing may change): every
(a) file in behaviour.md §15, run one at a time. Bench: `sqlite-store.ts --split` before and
after; reads must not get slower on a format-1 home.

### 4.2 Write side: one body per revision (`refs`), deferred

Not built in phase 4. Revisions stay format 1 (rule 4) until a later task gives the W consumers
of revisions a bounded reader, and that task is reviewed. The outline below is for the brief that
follows it.

- Module: `history-index.ts` `record` (`:227`, the insert at `:142`). When the revision's logical
  JSON is byte-equal to the item JSON in the event row written at the same seq, compared before
  either is stored, store the stub, `ref_seq`, `body_size` and no body. Also every path of
  rule 7.
- Proof, on and off: `history-storage.process.test.ts`,
  `history-publication-recovery.process.test.ts`, `stored-history-trust.test.ts`,
  `write-path-reads.test.ts`, `item-store-trusted-reads.test.ts`, `thread-delete.process.test.ts`,
  `thread-delete-crash.process.test.ts`, `thread-purge.process.test.ts`,
  `deleted-thread-recovery.process.test.ts`, `storage/data-retention.process.test.ts`,
  `storage/retention.process.test.ts`, `storage/compaction.process.test.ts`,
  `storage/recovery.process.test.ts`, `payloads.process.test.ts`, `migrations.process.test.ts`,
  the four `search-replay-*.process.test.ts`, `long-thread-lifecycle.process.test.ts`; then the
  cross-mode gate (written with it on, reopened with it off, and back).
- Bench: `sqlite-store.ts --split` (WAL pages per commit, database growth over the write
  phase), `event-writes.ts`.
- Failure modes: a crash between a revision and its event row (one transaction: both or
  neither); a purge batch boundary (rule 7); a restart with the switch flipped (rule 9); a
  reference read inside the transaction that wrote it (one connection, so it sees the row).

### 4.3 Write side: compressed bodies (`zstd`)

**4.3a Plain zstd.** Row kinds the inventory cleared get a stub, `body` (format byte, dictionary
id 0, zstd level 3 frame) and `body_size`. Modules: the `events` insert (`event-writer.ts:180`,
or `EventWriter::store_event` once 5.3a has landed). Revisions stay format 1 (rule 4).

**4.3b Dictionaries.** Rule 8's tables and rules, the trainer in
`crates/ace-store/src/format/train.rs`, and an idle shell beside `stored-trust-pass.ts`. Kinds:
one dictionary per measured event type (`item.updated`, `item.created`, `item.delta`,
`thread.client.updated`, `agent.status`), each only once the inventory has cleared it; every
other cleared kind stays plain zstd. Revisions stay format 1 (rule 4).

- Proof, on and off: the 4.2 outline's list, plus `stored-trust-pass.test.ts`, `stored-trust-rows.test.ts`,
  `stored-trust-coverage.test.ts`, `stored-shape.test.ts`, `usage-replay.test.ts`,
  `usage-reads.process.test.ts`, `wal-maintenance.process.test.ts`,
  `daemon-crash-recovery.process.test.ts`; the cross-mode gate.
- Bench: as 4.2, and decode time per row on the read benches (ADR 0222 measured 0.4 to 3 µs).
- Failure modes: a dictionary insert rolled back after a frame was encoded with it (the frame is
  in the same transaction, so it rolls back too; the cache never saw it, rule 8); training
  interrupted by shutdown (it resumes, and a half-trained dictionary is never inserted); a body
  over SQLite's limits (stays format 1).

### 4.4 Search: index long tool output up to 64 KiB (`search-cap`)

How the search writer takes a body today (`packages/search/src/thread-writer.ts`): each item
field has a segment row in `search_full_segments`. An inline delta appends its text to the
segment at once (`append`, `:200`), which keeps a bounded tail and indexes each sealed chunk
once; sealed chunks overlap. A delta of a body backed by a stored output stream only raises the
segment's `target` by its byte length (`:77` to `:85`). `flush` (`:249` to `:289`) then drains
the source: while `offset < target` it reads up to 32 KiB from the output store, appends it, and
persists `offset`.

- Modules: `thread-writer.ts` (the delta path, `append`, `flush` and the segment reset on
  replacement), `writer.ts`, and the rebuild paths (`apps/daemon/src/search-replay.ts`,
  `history-search-replay.ts`), which feed the same writer.
- Columns: R adds `indexed_bytes INTEGER` and `capped INTEGER` to `search_full_segments` (rule
  3's form: nullable, read as 0).
- Rule: message and reasoning bodies stay whole. Every other body is indexed up to 64 KiB per
  logical body, meaning per segment, cumulatively across every way text reaches it: inline
  deltas, the source drain, `item.created`, `item.updated` and rebuild. A rebuild indexes what
  live indexing did, apart from legacy segments (below).
  - Count: `indexed_bytes` grows by the UTF-8 bytes (`Buffer.byteLength`) of the new text each
    `append` takes in, whatever the stream's encoding. Each source byte is counted once, never
    the overlap the sealed chunks repeat.
  - Cut: the append that reaches 64 KiB takes text only up to the last whole code point at or
    below the cap, never between the halves of a surrogate pair. In the same statement it sets
    `capped = 1`, and for a stream-backed segment it sets `offset = target`.
  - Stop, as one invariant: **`capped = 1` implies `offset = target`**, kept by every
    statement that writes `offset` or `target`. A capped row is then never pending (the
    `search_full_pending` triggers and index count `offset < target`, `thread-schema.ts:21`), so
    `flush` never selects it and never reads its source again. The three writers today:
    - the stream delta (`thread-writer.ts:77` to `:85`, `target = target + ?`) becomes
      `target = target + ?, offset = CASE WHEN capped = 1 THEN target + ? ELSE offset END`;
    - the reusable `item.updated` source (`:131`, `SET stream=?,encoding=?,target=?`) also
      sets `offset = CASE WHEN capped = 1 THEN ? ELSE offset END` with the same new target;
    - `flush`'s cursor write (`:279`, `SET offset=?`) becomes
      `SET offset = CASE WHEN capped = 1 THEN target ELSE ? END`, because the `append` just
      before it may have set the cap.
      On a capped segment an inline delta appends nothing.
    - A capped row can still be dirty: the append that reached the cap sets `dirty = 1`, as
      every `append` does. The cap never clears `dirty`. `flush`'s second loop
      (`thread-writer.ts:291` to `:296`) publishes dirty rows whatever `capped` says, so the
      final tail up to the cut is indexed; the pending count keeps counting the row until then
      (`thread-schema.ts:19` to `:26` count `dirty = 1` too).
  - Reset: the non-reusable path (`:118`, which deletes the chunks and sets `tail='t'`,
    `offset=0`, `target=0`) also sets `indexed_bytes = 0, capped = 0` in the same statement, and
    the cap applies afresh to the new body. The reusable path keeps the indexed text, so the
    count and the cap persist. The count follows the indexed text and nothing else.
  - Legacy segments: rows written before this code have `indexed_bytes` NULL, and their
    indexed text is unknown, possibly over the cap. They are not capped: an append to a NULL row
    leaves it NULL and indexes as today. A row enters the cap on its next reset (which sets 0),
    and every segment the new code creates starts at `indexed_bytes = 0, capped = 0`. The code
    keeps the count with the switch off too, and only caps with it on. So a rebuild (which
    creates segments afresh) caps everything, while live indexing caps only segments created or
    reset since; the PR states this difference.
- Existing rows stay as they are, and nothing reindexes at open.
- Proof, on and off: `packages/search/src/search.process.test.ts`,
  `thread-search.process.test.ts`, `outputs.process.test.ts` (stream-backed bodies),
  `pagination.process.test.ts`, `apps/daemon/src/search.outputs.process.test.ts`, the four
  `search-replay-*.process.test.ts`. One new test file is allowed, because nothing covers this
  behaviour today. With the cap on, text after the first 64 KiB is not found in three cases: a
  tool output streamed inline in many deltas, a stream-backed output drained by `flush` (it also
  asserts the drain stops reading the source at the cap), and both after a rebuild.
- Bench: index size (`dbstat` on the search tables), source bytes the drain reads, and in-thread
  search p50 from `sqlite-store.ts --split`, on a clone rebuilt with the cap on and off. Dropped
  if it saves less than a gigabyte there (owner's answer 2).

## Phase 5: the writer, as builder tasks

Five tasks, in this order, each its own PR on the writer branch, each reviewed before the next
starts: 5.1 the projection fold, 5.2 sequence reservation, 5.3 the event writer, 5.4 the live
buffer, 5.5 the transaction stack. Tasks 5.1 and 5.2 are small and self-contained; 5.3 to 5.5
are split into steps, and a step marked "needs a decision" is not briefed until the orchestrator
makes it.

Recorded decisions (orchestrator, on the owner's delegation, 2026-11-23):

- 5.3b: Rust reproduces Zod's stripping and defaults through the generated `ace-protocol`
  types, pinned by vectors from existing samples (task 5.3, step 5.3b). The planner's reading,
  written into the 5.3b brief: the generated part is a shape table (`ace-protocol/src/shapes.rs`)
  that the same generator writes from the same Zod schemas, not the `typify` structs, because a
  serde round trip changes numbers, key order and lone surrogates (rule 5).
- Performance: 5.1 and 5.4 may merge switched off even if their benches are slower while
  TypeScript is the caller, since each call converts JavaScript values to and from JSON. Their
  gain is measured under E5 (ADR 0223) and ADR 0226, when the thread and the buffer stay in
  Rust. Every other part stays off until its numbers are no worse (rule 10).

What phase 5 does not do while TypeScript is the caller: move a loop whose body calls back into
TypeScript collaborators. Phases 1b and 3 measured that crossing values into JavaScript costs
more than it saves, so a loop moves to Rust only when everything it calls is Rust, or when the
Rust engine (ADR 0223 E5) is its caller.

Shared layout:

```
native/daemon/crates/ace-projection/        new: @ace/projection's daemon-side folds
  src/lib.rs                                 pub use thread::{update_thread, is_sidebar_event, FoldError}
  src/thread.rs
  src/columns.rs, src/strip.rs               5.3b-1: thread column encoding
  tests/vectors.rs                           reads native/daemon/vectors/fold.json
  tests/column_vectors.rs                    5.3b-1: reads native/daemon/vectors/columns.json
native/daemon/crates/ace-protocol/src/      shape.rs (hand-written), shapes.rs (generated), 5.3b-1
native/daemon/crates/ace-store/src/writer/  new
  mod.rs
  sequences.rs                               5.2
  events.rs                                  5.3a
  thread_columns.rs                          5.3b-2
  live/{mod.rs, compact.rs, buffer.rs, retry.rs}   5.4
  transaction.rs                             5.5
native/daemon/crates/ace-daemon-node/src/writer.rs  the binding for all of phase 5
native/daemon/vectors/fold.json             generated by scripts/store-vectors.ts
native/daemon/vectors/columns.json          generated by scripts/column-vectors.ts (5.3b-1)
apps/daemon/src/native-writer/              the TypeScript shells, one file per task
```

### Task 5.1: the projection fold (`fold`)

**Files the builder may touch:** `packages/provider-kit/src/native-switches.ts` (the switch,
rule 9), `packages/provider-kit/src/native-sqlite.ts` and `src/sqlite.ts` (export `nativeCall`,
rule 11), `native/daemon/crates/ace-projection/` (new), `native/daemon/crates/ace-daemon-node/`
(`Cargo.toml`, `src/lib.rs` for `mod writer;`, `src/writer.rs`),
`apps/daemon/src/native-writer/fold.ts` (new), `apps/daemon/src/event-writer.ts` (the call at
`:170` and its import: `updateThread` from `@ace/projection` becomes `foldThread` from
`./native-writer/fold.ts`), `native/daemon/Cargo.lock` (the new crate),
`apps/daemon/src/canonical-event-samples.ts` (new, moved), `apps/daemon/src/canonical-event.test.ts`
(import only), `scripts/store-vectors.ts` (new), `scripts/check-daemon-native.ts` (one call),
`native/daemon/vectors/fold.json` (generated). Nothing else.

**Port** `updateThread` and `isSidebarEvent` from `packages/projection/src/index.ts:164` to
`:235`, and nothing else from that package.

**What reaches the fold.** `updateThread` reads the event only for five payload types, and does
nothing at all for the rest (every branch is gated by type, and `isSidebarEvent`, `:228`, lists
only these). So the shell decides in TypeScript what crosses, and sends nothing for other events
(no `item.created` or `item.updated` body ever reaches the binding):

| Payload type                       | What crosses                                     | What the fold does                         |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| `queue.updated`                    | `JSON.stringify(payload)`                        | rule 1, then rule 5                        |
| `thread.client.updated`            | `JSON.stringify(payload)`                        | rule 2, then rule 5                        |
| `thread.updated`                   | `JSON.stringify(payload)`, `seq`                 | rule 3, then rule 5                        |
| `thread.created`                   | nothing but `at`                                 | rule 5 only                                |
| `agent.created`, `origin` `"root"` | `JSON.stringify(payload.agent.id)` (a JSON text) | rule 4 (not a sidebar event, so no rule 5) |
| anything else                      | no call                                          | nothing; the shell returns at once         |

Strings cross only inside JSON text, never as an N-API `String` argument: N-API replaces a lone
surrogate with U+FFFD, and `JSON.stringify` escapes it (`\ud800`), which `ace-json` keeps.

**Crate** `native/daemon/crates/ace-projection` (depends on `ace-json` only; `ace-store` will
depend on it). `src/lib.rs` re-exports `src/thread.rs`:

```rust
/// One event as the fold reads it, built from what the shell sent.
pub enum FoldEvent<'a> {
    QueueUpdated { payload: &'a ace_json::Map },
    ThreadClientUpdated { payload: &'a ace_json::Map },
    ThreadUpdated { payload: &'a ace_json::Map, seq: f64 },
    ThreadCreated,
    RootAgentCreated { agent_id: &'a ace_json::JsString },
}

#[derive(Debug)]
pub enum FoldError {
    /// `kind` is not one of the five, or its payload is missing or the wrong JSON type.
    /// Display: "fold: unexpected input for <kind>".
    Input(String),
    /// `changes` (thread.client.updated) or `acp` (thread.updated) is not an object.
    /// Display: "fold: <field> is not an object".
    NotAnObject(&'static str),
}

impl<'a> FoldEvent<'a> {
    /// What the binding and the vector test both call: `kind` and the parsed `payload` text
    /// (None for thread.created) as the shell sent them, and `seq`.
    pub fn from_wire(kind: &str, payload: Option<&'a ace_json::Value>, seq: f64)
        -> Result<FoldEvent<'a>, FoldError>;
}

/// `updateThread`: folds one event into the thread, in place.
pub fn update_thread(thread: &mut ace_json::Map, event: FoldEvent<'_>, at: f64)
    -> Result<(), FoldError>;
/// `isSidebarEvent`, by payload type.
pub fn is_sidebar_event(kind: &str) -> bool;
```

`at` and `seq` are `f64` because they are JavaScript numbers; `update_thread` stores them with
`ace_json::Number::from(f64)`, which prints as `JSON.stringify` does (`-0` as `0`, `1e21`).

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
   `switch`, `title`, `titleSource`, `effectiveCapabilities`, `acpSupport`, `acp` (assigns
   `acpAgentId`, `installationId`, `instanceId`, in that order, from `payload.acp`: a field
   present is set in place or appended; a field absent from `payload.acp` becomes `undefined` in
   the TS, which `JSON.stringify` omits, so the port removes that key, dropping any old value),
   `status` (set, then `activitySeq` = `seq`), `archivedAt` (`null` removes),
   `goal` (`null` removes). A new key is appended when its statement runs, so two new keys land
   in statement order, not payload order.
4. `agent.created` of a root agent: `rootAgentId` = `agent_id`.
5. Last: if `is_sidebar_event(kind)` (`queue.updated`, `thread.created`, `thread.updated`,
   `thread.client.updated`), `updatedAt` = `at`.
6. `structuredCopy` is `JSON.parse(JSON.stringify(x))`; on JSON input it is a deep clone. A
   `Value::clone` is the port.

**Binding** (`ace-daemon-node/src/writer.rs`): a method on `NativeDatabase`, because the shell
reaches the addon only through `nativeHandle(db)`. It does not touch the connection.

```rust
#[napi] impl NativeDatabase {
    /// The folded thread as JSON text. `payload` is the text the shell sent, or None.
    #[napi] pub fn fold_thread(&self, env: Env, thread: String, kind: String, seq: f64, at: f64,
        payload: Option<String>) -> napi::Result<String>;
}
```

`thread` and `payload` are parsed with `ace_json::parse`; malformed JSON throws `SyntaxError`
through `json_bind::syntax_error`. A thread that is not an object, or a `FoldError`, throws an
`Error` with its message. The result is `ace_json::to_string` of the folded thread.

**Shell** `apps/daemon/src/native-writer/fold.ts`, two exports:

```ts
/** What crosses for this event, or undefined when the fold reads nothing of it. */
export function foldInput(event: Event): { kind: string; payload: string | null } | undefined;
/** updateThread with the switch off; with it on, the native fold, applied in place. */
export function foldThread(db: DatabaseSync, thread: Thread, event: Event): void;
```

`foldInput` implements the table above, nothing more. `foldThread`: with `storeWriterOn("fold")`
false, it calls `updateThread(thread, event)`. With it true: `input = foldInput(event)`; if
undefined, return. Otherwise
`text = nativeCall(() => handle.foldThread(JSON.stringify(thread), input.kind, event.seq,
event.at, input.payload))`, `next = JSON.parse(text)`, and replace `thread`'s own keys in place:
delete every own key, then define each key of `next` in order with `Object.defineProperty`
(`enumerable`, `writable`, `configurable` true), so `__proto__` stays an own key. The one call
site is `event-writer.ts:170` (`updateThread(thread, event)` becomes
`foldThread(this.source.db, thread, event)`). For `thread.created`, `thread` is
`event.payload.thread` itself (`event-writer.ts:132`), so the in-place replace also changes the
stored payload's `updatedAt`, as the TypeScript fold does. `status-store.ts:271` stays
TypeScript (it folds the cached status view, which moves with 5.3).

**Vectors.**

- Move the `samples` table out of `canonical-event.test.ts` into
  `apps/daemon/src/canonical-event-samples.ts` and import it back. This is a move: the test keeps
  every assertion.
- `scripts/store-vectors.ts` builds `native/daemon/vectors/fold.json`. Every case is first
  written as JSON **text** (`threadText`, `eventText`), and those texts are what the file
  records, never anything re-serialised after a fold ran (the fold mutates its inputs, and for
  `thread.created` the event itself). For each case it parses fresh copies:
  - `sidebar = isSidebarEvent(JSON.parse(eventText))`, on its own copy;
  - `kind = event.payload.type`, for every case, reaching or not;
  - `input = foldInput(event)`, imported from `fold.ts`, so the file holds exactly what crosses
    (`payload` is `input.payload`, or `null` when `input` is undefined, and `reaches` is whether
    `input` is defined);
  - `folded = JSON.stringify(thread after updateThread(thread, event))`, where for
    `thread.created` the thread is the parsed event's `payload.thread`, as the writer does.
    It writes
    `{ name, thread: threadText, event: eventText, kind, payload, seq, at, sidebar, reaches, folded }`.
    When `reaches` is false it checks that `folded` equals `JSON.stringify(JSON.parse(threadText))`
    and exits non-zero otherwise: the skip in `foldInput` must never hide a change.
- `--check` regenerates in memory and fails if the file differs. `scripts/check-daemon-native.ts`
  runs it.
- `crates/ace-projection/tests/vectors.rs` (`#![allow(clippy::expect_used, clippy::unwrap_used,
clippy::panic)]`, as `native/history`'s vector tests do) checks, for every case,
  `is_sidebar_event(kind) == sidebar`; and for every reaching case, that
  `FoldEvent::from_wire` and `update_thread` on the parsed thread give
  `ace_json::to_string(thread) == folded`, byte for byte.
- Cases that must be present (the reviewer counts them): every sample of the moved table; every
  field of rule 3 alone; all of them together on a thread that has none of them; each `null`
  removal; `cursor-sdk` with and without a `continuation`; `status` (priority 1: a status fold
  that differs could show a working thread as done); `acp` whole, and `acp` without `instanceId` on a thread that already has an `instanceId` (the
  folded thread has none);
  `changes` with `null`, with `__proto__`, with an array-index key, and in an order different
  from the thread's; `queue.updated` on a thread with and without `queue`; `thread.created`;
  `agent.created` root and non-root; an `item.created` and an `item.updated` with large bodies
  (not reaching); an unknown payload type; strings with a lone surrogate and with a split pair
  (in a title, in a change, in an agent id); numbers `1e21`, `1.5e-7`, `-0` and `2^53 - 1` in
  `seq` and `at`; a thread whose keys include an array-index key.

**Proof, on and off:** `thread-columns.process.test.ts` (it folds with the TypeScript
`updateThread` and compares with what the store wrote, so with `fold` on it checks Rust against
TypeScript), `store.test.ts`, `thread-cache.process.test.ts`, `revision-triggers.process.test.ts`,
`sidebar-columns.test.ts`, `thread-row-trust.test.ts`, `store-held-view-rollback.test.ts`,
`status-storage.process.test.ts`, `long-thread-lifecycle.process.test.ts`. Off only (they never
load the addon): `packages/projection/src/projection.test.ts`, `settled-lifecycle.test.ts`,
`live-metadata.test.ts`, `snooze-wake.test.ts`, `snooze-woke.test.ts`, and
`apps/daemon/src/canonical-event.test.ts` after the move. Rust: `cargo test -p ace-projection`.
Vectors: `bun scripts/store-vectors.ts --check`.

**Bench:** `event-writes.ts` on and off. Only thread-level events cross now, so the cost is
one `JSON.stringify` of the thread and one `JSON.parse` per such event. Record it. It may merge
switched off (recorded decision above); its gain is measured under E5 and ADR 0226.

**Do not:** import the addon in `packages/projection` (clients load that package); change
`updateThread`; send an event the table does not list; pass a JavaScript string as an N-API
`String` when it may hold a lone surrogate; use `serde_json`; add a Rust dependency other than
`ace-json`; validate the event (canonical input is trusted, ADR 0125); write any test other than
the vector test.

**Reviewer checks:** statement order against the TS line by line; `foldInput` against the table
and against `updateThread`'s branches; every vector case above is present and the generator's
no-op check runs; `cargo test -p ace-projection`, `bun scripts/store-vectors.ts --check` and
`check:daemon-native` pass; the proof files pass in all three modes; the bench numbers are in the
PR.

### Task 5.2: sequence reservation (`sequences`)

Two steps, each its own commit: 5.2a fixes the TypeScript, test first; 5.2b ports the fixed
TypeScript. **Files the builder may touch:** 5.2a: `apps/daemon/src/stream-sequences.ts`,
`apps/daemon/src/store-stream.ts`, `apps/daemon/src/store.ts` (the construction at `:231`), and
`apps/daemon/src/store-live-write-recovery.test.ts` (the one new test). 5.2b:
`native/daemon/crates/ace-store/src/writer/` (`mod.rs`, `sequences.rs`),
`native/daemon/crates/ace-store/src/lib.rs` (`pub mod writer;`),
`native/daemon/crates/ace-daemon-node/src/writer.rs`,
`apps/daemon/src/native-writer/sequences.ts` (new), `apps/daemon/src/stream-sequences.ts`
(the shared interface below), `apps/daemon/src/store.ts` (the field type at `:149`, the
construction at `:231`, the initialization at `:292`), `apps/daemon/src/event-writer.ts` (the
`sequences` type at `:29`), `apps/daemon/src/store-stream.ts` (the `sequences` type at `:45`),
`native/daemon/Cargo.lock`, and the switch's part name in `native-switches.ts`. Nothing else.

The three consumers name the concrete class `StreamSequences`, which has private state, so the
native class cannot stand in for it. 5.2b adds, in `stream-sequences.ts`,
`export interface SequenceAllocator { initialize(): void; reservedThrough(): number; head(): number; replaySafe(after: number): boolean; next(after: number): number; prepare(events: number, after: number): void; covers(seq: number): boolean; }`,
makes `StreamSequences` implement it, and changes the three declarations to
`SequenceAllocator`. Both `StreamSequences` and `NativeStreamSequences` implement it.

**What the TypeScript does today**, which the port keeps unless this brief says otherwise:

- Ordinary appends allocate without reserving: `EventWriter` calls `sequences.next`
  (`event-writer.ts:117`), and each event row's own `UPDATE host_sequence SET seq = MAX(seq,?)`
  (`event-writer.ts:182`) moves the high-water mark in that write's commit. Deletion tombstones
  do the same (`store.ts:1394` to `:1397`). Their sequences reach subscribers only after that
  commit.
- Only the live path reserves. `StoreStream.prepare` (`store-stream.ts:91`) opens a range at
  admission. `StoreStream.append` (`:96` to `:117`) allocates first (`next` per event, before any
  refill), pins the batch in the buffer, then calls `prepare(events.length, first.seq - 1)` to
  refill. A refill's `commit(run)` is `Store.atomic` (`store.ts:233`), whose `transaction`
  flushes the buffered batch first (`store.ts:568`): the flush commits those events with their
  own `host_sequence` updates, before the reservation SQL runs. When the refill returns, the
  batch is published (`publishPending`, `:117`) if it holds deltas only.
- `atomic` may not commit at all when it returns: nested in an open transaction it ends with
  `RELEASE` of a savepoint (`store.ts:576` to `:588`), and during `installHistory` it runs inline
  (`store.ts:569`). Today `reserved` and the lineage mark move as soon as `atomic` returns, even
  when an outer transaction later rolls back. That is a bug (a nested refill can publish deltas
  past a reservation that then rolls back), and step 5.2a fixes it in the TypeScript first: a
  reservation counts only once the outermost transaction that wrote it has committed.

**Step 5.2a: the TypeScript fix, test first, on main.** This fixes shipped TypeScript, so it is
not built on the rewrite branch. It goes to main as its own test-first PR: branch
`ace/fix-live-reservation-rollback` from `origin/main` (`git fetch origin` first; base the
worktree on `origin/main`, never the local `main`), push with
`git push origin HEAD:refs/heads/ace/fix-live-reservation-rollback`, and open the PR against
`main`. Once it has merged, `ace/rust-store-writer` takes it by merging `origin/main` (never a
rebase or a cherry-pick), and 5.2b starts after that merge.

The bug, as review confirmed it: a refill's `transaction` first drains the pinned batch
(`store.ts:582`). When the refill is nested in an outer transaction, that drain and the
reservation run inside savepoints (`store.ts:595`), so the event rows and their
`host_sequence` updates are still provisional. Yet `prepare` advances `reserved` and the
lineage mark as soon as `commit` returns (`stream-sequences.ts:55` to `:59`), and
`publishPending` (`store-stream.ts:117`) can publish the delta above the old range before the
outer transaction rolls back.

1. Write the new test in `apps/daemon/src/store-live-write-recovery.test.ts`, named "a live
   batch whose range refill rolls back with its outer transaction is published only once stored
   and reuses no sequence". Use the file's existing helpers (`store.prepareLiveWrite` and
   `store.bufferLiveWrite` with an unpinned snapshot, `:105`). The test:
   1. Opens a `Store` on a temp file, creates a thread, streams one warm-up delta so a range is
      reserved, and calls `store.flushLiveWrites()` so that delta is stored and nothing is
      pinned. Reads `reserved` from `SELECT seq FROM host_sequence WHERE id=1`.
   2. Moves the head to the end of the range out of band, as
      `engine/live-write-buffer.process.test.ts:380` does: `store.atomic` inserting one
      `thread.updated` event row at `reserved - 1`. The next batch of two deltas then has to
      refill.
   3. Subscribes. For every published `item.delta` it records the seq and whether, at that
      moment, a row with that seq exists in `events`, read on a second read-only connection
      (committed state only).
   4. Runs `store.atomic(() => { store.prepareLiveWrite(bytes); store.bufferLiveWrite(id, twoDeltas,
at, unpinned); throw new Error("outer"); })` and expects it to throw `"outer"`.
   5. Expects that no delta was published during step 4. Then calls `store.flushLiveWrites()`
      and expects exactly two delta publications, one for each of the two deltas (by their
      `append` text), each published once, and each with its committed row present when it was
      delivered.
   6. Closes and reopens the store, appends one `thread.updated`, and expects its seq to be
      greater than every seq published before.

   Run it and see it fail on today's code (step 5 fails: the nested refill publishes before the
   outer rollback). Commit the failing test.

2. Fix `stream-sequences.ts`, `store-stream.ts` and the wiring in `store.ts` so the test
   passes, keeping every file in the proof list passing:
   - `StreamSequences`' option `commit(run)` becomes `commit(run, outcome)`, and `store.ts:233`
     wires it to `this.transaction(run, outcome)` (the `TransactionOutcome` form,
     `store.ts:581`).
   - `prepare` updates `reserved` and calls `options.reserved?.(through)` only inside the
     outcome's `committed`, never right after `commit` returns. Its `rolledBack` does nothing
     (the pending range is forgotten).
   - **Confirmation is monotonic.** Commit publication can run a reentrant subscriber between
     settlements (`store.ts:652` to `:659`), so a newer reservation's `committed` can run before
     an older one's. `committed` therefore sets
     `reserved = Number.isNaN(reserved) ? through : Math.max(reserved, through)` (`reserved` is
     NaN when `host_sequence` had no row, `stream-sequences.ts:19`), and calls
     `options.reserved?.(through)` only when that raised `reserved`.
   - A new `covers(seq)` returns `seq <= reserved` (false while `reserved` is NaN).
   - `store-stream.ts` `append` (`:107` to `:117`): when the batch is empty, nothing changes (no
     `prepare`, no publication, as today). Otherwise it calls `publishPending()` only when
     `sequences.covers(<the batch's last seq>)`. When not covered, the pinned batch publishes as
     stored rows when its flush commits (`store-stream.ts:238` to `:256`).
   - Ordinary appends and tombstones are unchanged. They share the allocator (`next`): a
     tombstone (`recordDataDeletion`, `store.ts:1394` to `:1397`) and an event row each move
     `host_sequence` with their own row, in their own transaction, and are delivered (to
     subscribers, or to usage listeners for a tombstone) only after that commit. So they never
     pass through `covers`, and a rollback removes the row and its high-water mark together. The
     fix must not route them through `prepare`.

   Commit the fix. Proof for the PR: every file in this task's proof list, run one at a time
   with the default settings (TypeScript store), plus `bun run typecheck` and `bun run lint`.

**Step 5.2b: the port.**

**Port** `StreamSequences` (`apps/daemon/src/stream-sequences.ts`, all of it) to
`crates/ace-store/src/writer/sequences.rs`:

```rust
pub enum SequenceError { Exhausted }        // Display: "Sequence exhausted"
pub struct Sequences {
    cursor: Option<f64>,                    // None models the TS NaN (no host_sequence row)
    confirmed: Option<f64>,                 // reserved through, by a committed outermost
                                            // transaction; None models the TS NaN
}
impl Sequences {
    /// `SELECT seq FROM host_sequence WHERE id=1`. No row: `cursor` and `confirmed` are None,
    /// as `Number(undefined)` is NaN in the TS, and every `next` fails with Exhausted.
    pub fn initialize(conn: &Connection) -> Result<Sequences>;
    /// `reservedThrough()`: the confirmed reservation; NaN when None.
    pub fn reserved_through(&self) -> f64;
    /// Larger of MAX(events.seq) and MAX(usage_deletions.seq); 0 when both are empty.
    pub fn head(&self, conn: &Connection) -> Result<f64>;
    /// False when `after > head && after > confirmed`; else true for 0, for head, or for a seq
    /// stored in `events`.
    pub fn replay_safe(&self, conn: &Connection, after: f64) -> Result<bool>;
    /// Provisional allocation: assigns `cursor = max(cursor, after) + 1` first, then returns
    /// Exhausted when the new cursor is past 2^53 - 1, so the cursor has moved even when it
    /// throws (`stream-sequences.ts:46` to `:49`). A None cursor stays None and returns Exhausted.
    pub fn next(&mut self, after: f64) -> Result<f64, SequenceError>;
    /// Pure. None when `after + events <= confirmed`; else `Some(after + max(65536, events))`,
    /// or Exhausted when that is not a safe integer. Pending reservations never count.
    pub fn reservation(&self, events: f64, after: f64) -> Result<Option<f64>, SequenceError>;
    /// `UPDATE host_sequence SET seq=MAX(seq,?) WHERE id=1`, inside the caller's transaction.
    /// Changes no field.
    pub fn reserve(&self, conn: &Connection, through: f64) -> Result<()>;
    /// Monotonic, as 5.2a's TypeScript: `confirmed = Some(through)` when None or below
    /// `through`, else unchanged. Returns whether it rose; the shell calls `reserved` only then.
    /// Called only from the outcome's `committed`.
    pub fn confirm(&mut self, through: f64) -> bool;
    /// Whether every sequence through `seq` lies in the confirmed reservation.
    pub fn covers(&self, seq: f64) -> bool;
}
```

Every comparison with a None field is false, as every comparison with NaN is in the TS (so
`reservation` with `confirmed` None always returns a range, and `replay_safe`'s
`after > confirmed` test is false). Values are `f64` because both sides hold JavaScript numbers
until no TypeScript caller is left. Statements go through `stmt_cache.rs`.

**Binding:** `NativeDatabase::sequences(&self) -> napi::Result<NativeSequences>` runs
`Sequences::initialize` on the connection and returns a `#[napi]` class holding the
`Arc<Connection>` and the `Sequences`, with one method per function above. Non-finite or
non-integral input throws `RangeError`. Every call from the shell goes through `nativeCall`
(rule 11).

**Shell** `apps/daemon/src/native-writer/sequences.ts`: `class NativeStreamSequences` with the
public methods and constructor options `StreamSequences` has after 5.2a, and the same
behaviour, step for step:

- **Initialization is pinned to where it is today.** The constructor stores its options and
  touches neither the addon nor SQL: at `store.ts:231` the database has not been migrated, and on
  a fresh home `host_sequence` does not exist yet. `initialize()` is the first call into the
  addon: it creates the handle (`nativeCall(() => handle.sequences())`, which reads
  `host_sequence`). `store.ts` keeps calling it exactly where it calls
  `this.sequences.initialize()` today: right after `migrate(this.db)` (`:291`) and before
  `keepLineage` (`:294`), which reads `reservedThrough()`. Any method called before
  `initialize` throws `Sequences are not initialized`.
- **One cursor.** `store.ts` builds one `StreamSequences` or one `NativeStreamSequences` (the
  switch decides) and hands that same instance to the three allocators: `EventWriter`
  (`event-writer.ts:117`), `StoreStream` (`store-stream.ts:100`) and tombstones
  (`recordDataDeletion`, `store.ts:1394`). None of them keeps a cursor or a reservation of its
  own.
- `prepare(events, after)`: `through = reservation(events, after)`; if none, return. Else
  `commit(() => native.reserve(through), { committed: () => { if (native.confirm(through))
options.reserved?.(through); }, rolledBack: () => {} })`. `committed` runs after the outermost
  `COMMIT` returns; a rollback anywhere around it forgets the pending range. During
  `installHistory`, a `transaction` with an outcome throws `Store is busy` (`store.ts:585`),
  which the live path already treats as "retry later".
- `covers(seq)` is `native.covers(seq)`; `store-stream.ts` already uses it after 5.2a.

**Guarantees, stated separately:**

- Process crash (WAL, `synchronous=NORMAL`): every committed transaction survives, so every
  sequence a subscriber has seen is either in a committed reservation or in a committed row.
  Restart reads `host_sequence`, which is at least every sequence handed out and committed.
- Power loss or OS crash: commits since the last checkpoint's fsync may be lost, including a
  reservation whose deltas clients saw. Two things catch this: the lineage mark (written after
  the reservation committed and before publication), which makes `keepLineage`
  (`store.ts:1047`) rename the database at open; and `replay_safe`, which refuses cursors past
  head and reservation. The port must not weaken either one. Making the mark itself durable
  against power loss is out of scope here.

**Invariants:** strictly increasing, never reused (the cursor is in memory and never moves back,
even when a rollback discards rows); a sequence reaches a subscriber only when covered by a
confirmed reservation or by its own committed row; `confirmed` moves only after the outermost
commit; `Sequence exhausted` past 2^53 - 1; head counts deletion tombstones.

**Proof, on and off** (5.2a's fix is TypeScript, so every file passes with the switch off
too): `store-live-write-recovery.test.ts` (including 5.2a's test, the one that crosses a range
boundary and rolls back), `store.test.ts`, `sequence-lineage.test.ts`, `store-live-writes.test.ts`,
`subscription-replay.test.ts`, `history-storage.process.test.ts`,
`history-publication-recovery.process.test.ts`, `usage-replay.test.ts`,
`thread-delete.process.test.ts`, `daemon-crash-recovery.process.test.ts`,
`engine/live-write-buffer.process.test.ts` (it crosses a range boundary at `:380` without a
rollback, and covers restart without reuse at `:266`), `engine/storage-behaviour.process.test.ts`.
No other new test. If a file other than the new test fails after 5.2a, stop and report the
failing test; do not change it.

**Failure modes:** refill fails (the batch stays pinned and unpublished; the retry flush stores
it with its own `host_sequence` updates); outer rollback after a nested refill (pending
forgotten, `confirmed` and the mark unchanged, cursor not moved back); crash after a reservation
commits and before its sequences are used (a gap, which `replay_safe` handles).

**Do not:** keep a second cursor in TypeScript; open or end a transaction in Rust; change the SQL
text; change `host_sequence`'s format (older builds read it); count a pending reservation
anywhere.

**Reviewer checks:** the no-row (NaN) and exhaustion cases match the TS; `confirm` is reached
only through the outcome's `committed`; `publishPending` is guarded by `covers`; the proof files
pass in all three modes; `event-writes.ts` and `live-write-buffer.ts` on and off.

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

The SQL is `event-writer.ts`'s, with the `events` insert in its named-column form
(`INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (?, ?, ?, ?, ?, ?)`, phase 4
rule 3); if the TypeScript insert is still positional when 5.3a starts, 5.3a changes it to the
same named form in the same commit, so both writer modes write the same statement. `at` in `EventRow` is the append's `at`
argument, as the TS stores it, not `event.at`. `payload_json` is the TypeScript's
`JSON.stringify(event.payload)` after capping, stored as given. `WriteError::WorkspaceUnregistered`
carries the message `workspace_unregistered`. Binding: `NativeDatabase::event_writer()`, a class
with `createThread(...)` and `storeEvent(...)`. Shell: every call goes through `nativeCall` (rule 11). In `event-writer.ts`, the two blocks
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

**Step 5.3b: thread column writes (decided 2026-11-23, briefed after 5.3a's review).** Two
builder rounds, each its own PR and review: 5.3b-1 is the pure encoder, the generated shapes and
the vectors, with no runtime change; 5.3b-2 is the SQL, the binding and the shell, behind a new
part, `columns`. 5.3b-2 starts once 5.3b-1 has merged into the writer branch. Rust has to own
this eventually: the daemon is leaving Bun (ADR 0226). This overrides ADR 0222's "Rust fetches,
TypeScript shapes" for the three schemas below only.

**How the decision is read.** The `typify` structs in `generated.rs` can't give Zod's output:
`serde_json` prints `1.0` where JavaScript prints `1`, sorts the keys of a `serde_json::Value`,
rejects a lone surrogate, and an `Option` with `#[serde(default)]` can't tell an absent key from
a default the schema inserts. So "through the generated `ace-protocol` types" means that the same
generator (`scripts/generate-rust-protocol.ts`) writes a second file from the same Zod schemas,
`ace-protocol/src/shapes.rs`: a table of what each object keeps, in which order, and which
defaults it inserts. Rust walks `ace-json` values with it (rule 5). `--check` keeps it fresh as it
does `generated.rs`, and the vectors prove that the table and the walk give Zod's output.

**What it replaces.** Read these side by side with the Rust:

- `apps/daemon/src/thread-columns.ts`, all of it: `ThreadClientColumn` and `clientKeys` (`:10`,
  `:11`), the `columns` table (`:14` to `:70`), `comparisons` (`:77`), `columnNames` and
  `coldColumns` (`:81`, `:83`), `encodeThreadClient` (`:86`), `threadColumnValue` (`:90`) and
  `threadColumnChanges` (`:102` to `:124`).
- `apps/daemon/src/event-writer.ts` `writeThread` (`:252` to `:289`), through the revision read:
  the change set (`:257`), the `threadRowConfirmed` read (`:260`), the `UPDATE threads` (`:262`),
  the `thread_cold` upsert with its `value` closure (`:268` to `:279`) and the revision `SELECT`
  (`:280` to `:283`). `rebuildThread` (`thread-row.ts:178`), `keepThreadRowConfirmed` and the
  `remember*` calls (`:284` to `:288`) stay TypeScript: `rebuildThread` is the validated decode,
  and `thread-row.ts`'s source is part of the trust fingerprint (`threadRowShape`,
  `thread-row-trust.ts:34`), so no step touches that file.
- `writtenColumns` and `updated` (`event-writer.ts:292` to `:317`) stay TypeScript, since they
  read the payload, which does not cross. 5.3b-1 moves them to `thread-columns.ts` so the vector
  generator can import them.

Not in scope: the `encodeThreadClient` calls in `thread-client-storage.ts` (`:86`, `:118`,
`:150`, live metadata; they move with 5.3c), the sidebar index, status and the creation row. The
sidebar index listens to revision rows, not to the columns: its triggers fire on
`sidebar_thread_revisions` (`sidebar-columns.ts:114`), which the `threads` and `thread_cold`
triggers bump on Rust's writes as they do on the TS's, so nothing about it changes. Status and
its side tables stay TypeScript (`this.source.status.persist`, `event-writer.ts:202`;
`status-store.ts` moves in 5.3c). The creation row is 5.3a's `createThread`; on creation
`writeThread` writes the other columns, as today.

**The columns**, 16, in the table's order, with their parts: `id`, `workspace_id`, `title`,
`provider`, `created_at`, `updated_at`, `archived_at`, `imported`, `root_agent_id` (`base`),
`status` (`status`), `client` (`client`), `details` (`details`), `transitions` (`transitions`),
`provider_metadata` (`metadata`), `capabilities` (`capabilities`), `acp` (`acp`). `details` and
`capabilities` are cold (`thread_cold`), the rest hot (`threads`). Port each encoding exactly:

| Column                                                                | Encoded from `thread`                                                                                                                                                                                        | Compared by                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `id`, `workspace_id`, `title`, `provider`, `created_at`, `updated_at` | the field as it is: a string is text, a number is a number                                                                                                                                                   | its encoding                                                                                                 |
| `archived_at`, `root_agent_id`                                        | the field, or null when absent or null (`?? null`)                                                                                                                                                           | its encoding                                                                                                 |
| `imported`                                                            | `JSON.stringify(imported)` when it is JavaScript-truthy, else null                                                                                                                                           | its encoding                                                                                                 |
| `status`                                                              | `JSON.stringify(status)`                                                                                                                                                                                     | its encoding                                                                                                 |
| `client`                                                              | `JSON.stringify(ThreadClientColumn.parse(thread))`: `strip(THREAD_CLIENT_COLUMN, thread)`                                                                                                                    | `JSON.stringify(clientKeys.map((key) => thread[key]))`: an array in the shape's key order, `null` for absent |
| `details`                                                             | null when absent, else `JSON.stringify(ThreadDetails.parse(details))`: `strip(THREAD_DETAILS, details)`                                                                                                      | `JSON.stringify(details) ?? ""`                                                                              |
| `transitions`                                                         | `JSON.stringify` of `lineage`, `delegatedBy`, `delegatedFrom`, `startedBy`, `startedByClient`, `treeRootId`, `queuedLaunch`, `execution`, `switch`, in that order, absent ones left out, values not stripped | its encoding                                                                                                 |
| `provider_metadata`                                                   | the same with `backend`, `handoff`, `permission`, `titleSource`, `queue`, `goal`                                                                                                                             | its encoding                                                                                                 |
| `capabilities`                                                        | null when absent, else `JSON.stringify(capabilities)` (a stored `null` is the text `"null"`)                                                                                                                 | its encoding                                                                                                 |
| `acp`                                                                 | `JSON.stringify(ThreadProviderMetadata.parse(thread))`: `strip(THREAD_PROVIDER_METADATA, thread)`, always an object text (`{}` at least)                                                                     | its encoding                                                                                                 |

Compares are JavaScript `===`: texts by UTF-16 units, numbers numerically (`-0 === 0`), null
equals null, different kinds never equal. Compare printed texts, never `ace_json::Value`s: two
`details` with the same content in another key order are a change, as they are in the TS.

`threadColumnChanges(previous, next, wanted)`, statement by statement: for each name of `wanted`,
in order: skip it when `previous` exists and both compares are equal; `value = encode(next)`;
skip it when there is no `previous`, the column is cold and `value` is null; push
`[name, value]` onto `cold` or `hot`; add its part; set `row[name] = value`. Then, for every
column in table order whose part was added and which is not in `row`,
`row[name] = encode(previous ?? next)`. Parts keep insertion order. The cold upsert binds
`(id, value("details"), value("capabilities"))`, where `value(name)` is the change's value when
`name` is in `cold`, else `encode(previous)` when there is a `previous`, else null.

**How Zod's parse is reproduced, and where it is not.** On these values Zod 4 (the 4.6 line in
the lockfile) does three things. It keeps only the schema's keys, in the schema's order, at every
object level: unknown keys, `__proto__` and array-index keys are dropped, and a record keeps its
keys in JavaScript order but drops `__proto__`. It inserts each default for an absent key at the
key's place; there are two today, `ThreadDetails.workspaceChange.lossy` (`true`) and
`ThreadProviderMetadata.acpSupport.subagentSessions` (`false`). And it validates, throwing a
`ZodError`. Rust does the first two and not the third:

- Stripping and defaults are the shape walk below, and the vectors pin them.
- Validation stays Zod, inside the same transaction. Rust copies any value it can't shape (the
  wrong JSON type, a missing required key, an unknown discriminator) unchanged. Every write that
  changes a Zod-encoded column then reaches `rebuildThread`: the triggers give every written row a
  revision, and the part decoders parse the written column with the same schema
  (`thread-row.ts:45` for client, `:49` for details, `:69` for acp). So the same invalid value
  throws a `ZodError` before the append's transaction commits, and the write rolls back as it does
  today. Constraints (lengths, patterns, integers, URL formats, `refine`) are not ported. The owner
  accepts this only while `rebuildThread` is TypeScript (2026-11-23). When Zod leaves the write
  path (ADR 0223 E5, or ADR 0226's port of the decode), Rust must validate these columns itself
  before writing, and that task's brief owns it.
- Two divergences remain, both only for a thread that isn't canonical. The writer folds canonical
  events into threads decoded from validated or confirmed rows (ADR 0125), so neither can happen
  in the daemon: the `ZodError`'s path starts inside the column rather than the thread; and an
  invalid value in a column whose compare finds no change throws in the TS (`acp` encodes both
  sides to compare them) but not in Rust. The PR records both.

**The shape table.** `native/daemon/crates/ace-protocol/src/shape.rs`, hand-written, with no
dependencies:

```rust
/// What Zod's parse keeps of a value, generated from the schema.
pub enum Shape {
    /// Kept as it is: strings, numbers, booleans, null, enums, literals, `z.unknown`, and
    /// unions, arrays and nullables whose every part is `Copy`.
    Copy,
    /// `z.object` in strip mode: the fields in schema order; any other key is dropped.
    Object(&'static [Field]),
    /// `z.array`: each element through the shape.
    Array(&'static Shape),
    /// `z.record` with string keys: own keys in JavaScript order, `__proto__` dropped, each
    /// value through the shape.
    Record(&'static Shape),
    /// `.nullable()`: null is kept, anything else goes through the shape.
    Nullable(&'static Shape),
    /// `z.discriminatedUnion`: the option whose literal, as JSON text (`"\"pr\""`), equals the
    /// value's `key` field printed.
    Tagged { key: &'static str, options: &'static [(&'static str, Shape)] },
}
pub struct Field { pub key: &'static str, pub presence: Presence, pub shape: Shape }
pub enum Presence {
    Required,
    /// `.optional()`: an absent key stays absent.
    Optional,
    /// `.default(v)`, `v` as JSON text: an absent key gets `v` at its place.
    Default(&'static str),
}
```

`native/daemon/crates/ace-protocol/src/shapes.rs`, generated and never hand-edited, holds
`pub static THREAD_CLIENT_COLUMN: Shape` (`ThreadClientFields.omit({ details: true })`, the omit
of `thread-columns.ts:10`), `pub static THREAD_DETAILS: Shape` and
`pub static THREAD_PROVIDER_METADATA: Shape`. A schema object reached twice is emitted once, as
its own `static`. The header records the table's depth.

The generator half is `scripts/rust-protocol-shapes.ts` (new, pure),
`shapesSource(roots: Record<string, z.ZodType>): string`, walking Zod 4's public `schema.def`.
`generate-rust-protocol.ts` calls it and writes or `--check`s `shapes.rs` the way it does
`generated.rs` (rustfmt, the same header comment). The walk throws, naming the schema path, on
anything whose output the table can't describe, so a later schema change fails
`check:daemon-native` instead of drifting: `pipe` and `transform`, `catch`, `prefault`,
`nonoptional`, `lazy`, `intersection`, `tuple`, `map`, `set`, `date`, `bigint`, `custom` and any
type it doesn't name; coercion (`z.coerce.*`, any def with `coerce: true`) and codecs
(`z.codec`, `z.stringbool`); an object with a catchall (`passthrough`, `strict`, `catchall`); any
check that normalizes, which Zod 4 runs as kind `overwrite` (`trim`, `toLowerCase`,
`toUpperCase`, `normalize`, `slugify` and any other), since each changes the output; a `z.union` with an
option that isn't `Copy`; a record whose key schema has a closed set of values or isn't a string;
`.optional()` anywhere but directly on an object field, or wrapped in or around `.default()`; a
default that isn't a JSON primitive; a discriminated union whose options aren't objects or whose
discriminator isn't a string literal. `readonly` is transparent. `Nullable(Copy)`, `Array(Copy)`
and unions of `Copy` collapse to `Copy`. The planner walked the three roots on this branch and
they reach none of the refused forms: objects, arrays, one record (`live.options`), two
discriminated unions on `on` (`snoozeWake`, `snoozeWoke`), primitive unions, the two boolean
defaults. If the builder's generator refuses one, stop and report it.

**The walk**, `ace-projection/src/strip.rs`:
`pub fn strip(shape: &Shape, value: &ace_json::Value) -> ace_json::Value`, a new value, the
input unchanged:

- `Copy`, or a value of the wrong JSON type for the shape (not an object for `Object`, `Record`
  or `Tagged`, not an array for `Array`): `value.clone()`.
- `Object`: a new `ace_json::Map`; for each field in order: when present, insert
  `strip(field.shape, v)`; when absent with `Default(text)`, insert `ace_json::parse(text)`;
  else nothing.
- `Array`: each element stripped, in order. `Record`: each key in the map's order except
  `__proto__`, its value stripped. `Nullable`: null kept, else the inner shape. `Tagged`: the
  option whose literal equals `ace_json::to_string` of the value's `key` field; none, a clone.

Recursion follows the shape, never the value: a `Copy` subtree is cloned by `ace-json`, which
doesn't recurse, so the depth is the table's whatever the input.

#### Step 5.3b-1: the encoder, the shapes and the vectors (no runtime change)

**Files the builder may touch:** `scripts/rust-protocol-shapes.ts` (new),
`scripts/generate-rust-protocol.ts` (the call and the second output),
`native/daemon/crates/ace-protocol/src/` (`lib.rs`, `shape.rs` new, `shapes.rs` generated),
`native/daemon/crates/ace-projection/` (`Cargo.toml` for `ace-protocol`, `src/lib.rs`,
`src/columns.rs` and `src/strip.rs` new, `tests/column_vectors.rs` new),
`apps/daemon/src/thread-columns.ts` (receives `writtenColumns` and `updated`; exports
`threadColumnNames` and `coldRowValues`), `apps/daemon/src/event-writer.ts` (imports them; the
`value` closure at `:270` becomes `coldRowValues`; nothing else),
`apps/daemon/src/thread-column-samples.ts` (new), `apps/daemon/src/thread-columns.process.test.ts`
(import only), `scripts/column-vectors.ts` (new), `native/daemon/vectors/columns.json`
(generated), `scripts/check-daemon-native.ts` (one call), `native/daemon/Cargo.lock`. Nothing
else.

**TypeScript moves**, behaviour unchanged:

```ts
// thread-columns.ts
/** Every column, in the table's order (what `columnNames` holds). */
export const threadColumnNames: readonly ThreadColumn[];
/** Moved from event-writer.ts:308, with `updated`. */
export function writtenColumns(payload: EventPayload): ThreadColumn[];
/** What `writeThread`'s cold upsert binds after `thread_id`: details, then capabilities. */
export function coldRowValues(
  previous: ReadonlyThread | undefined,
  changes: ThreadColumnChanges,
): [ColumnValue, ColumnValue];
```

**Rust** `ace-projection/src/columns.rs`, re-exported from `lib.rs`:

```rust
pub enum Column { Id, WorkspaceId, Title, Provider, CreatedAt, UpdatedAt, ArchivedAt, Imported,
    RootAgentId, Status, Client, Details, Transitions, ProviderMetadata, Capabilities, Acp }
pub enum Part { Base, Status, Client, Details, Transitions, Metadata, Capabilities, Acp }
impl Column {
    pub const ALL: [Column; 16];                 // the table's order
    pub fn name(self) -> &'static str;           // "workspace_id", ...
    pub fn from_name(name: &str) -> Option<Column>;
    pub fn part(self) -> Part;
    pub fn is_cold(self) -> bool;                // details, capabilities
}
impl Part { pub fn name(self) -> &'static str; } // "base", "metadata", ...
/// What a column stores: a JavaScript string, number or null.
pub enum ColumnValue { Text(ace_json::JsString), Number(f64), Null }
#[derive(Debug)]
pub enum ColumnError {
    /// A base field, or `status`, that is not text, a number or null (an absent `status` too).
    /// Display: "thread column <name> cannot be stored". The TS fails at SQLite's bind instead.
    NotStorable(Column),
}
pub struct ColumnChanges {
    pub row: Vec<(Column, ColumnValue)>,         // in `row`'s insertion order
    pub hot: Vec<(Column, ColumnValue)>,
    pub cold: Vec<(Column, ColumnValue)>,
    pub parts: Vec<Part>,                        // insertion order, no repeats
}
pub fn column_value(thread: &ace_json::Map, column: Column) -> Result<ColumnValue, ColumnError>;
pub fn column_changes(previous: Option<&ace_json::Map>, next: &ace_json::Map, wanted: &[Column])
    -> Result<ColumnChanges, ColumnError>;
pub fn cold_row_values(previous: Option<&ace_json::Map>, changes: &ColumnChanges)
    -> Result<[ColumnValue; 2], ColumnError>;
```

A JSON column's `Text` is `ace_json::to_string` of the built or stripped value. JavaScript
truthiness, for `imported`: false for `false`, `0`, `-0`, `""` and null; true for anything else.

**Samples**, `apps/daemon/src/thread-column-samples.ts`:

- `capabilities(variant)`, moved from `thread-columns.process.test.ts`, which imports it back and
  keeps every assertion. It calls no random generator, so the test's seeded stream is unchanged.
- `fieldSamples`: one value per field of the three schemas, which the field's schema accepts
  unchanged. Where an existing test has one it is copied as written: `acpSupport` from
  `acp-identity.process.test.ts`, `snoozeWake` from `thread-organization.process.test.ts`,
  `pullRequestWorkspace` and `workspaceChange` from `workspace-move.process.test.ts`,
  `checkoutMissing` from `checkout-missing.process.test.ts`, `effectiveCapabilities` as
  `capabilities(1)`. The others are the smallest value the schema accepts with every optional
  nested field given.

**Vectors**: `scripts/column-vectors.ts` writes `native/daemon/vectors/columns.json`, as
`fold.json` is made. Every case is first written as JSON **text** (`previous`, `next`), and only
those texts are recorded. Cases that need `-0`, a lone surrogate, a split pair or a `__proto__`
key are written as literal text, which `JSON.stringify` can't make. For each case the generator
parses fresh copies and records:

```
{ name, previous: text | null, next: text, wanted: [column names],
  values: [[column, value], ...],    every column in table order: threadColumnValue(next, column)
  changes: null | { row, hot, cold: [[column, value], ...], parts: [names], coldRow: [value, value] | null } }
```

A value is `["text", s]`, `["number", String(n)]`, `["null"]`, `["rejected"]` when
`threadColumnValue` throws (a `ZodError`), or `["unstorable"]` when it returns a value SQLite
won't bind. `threadColumnValue` never binds (`thread-columns.ts:90`), so catching its throws
can't find unstorable values; a real statement decides instead. For every value it returns, the
generator runs `new DatabaseSync(":memory:").prepare("SELECT ?").get(value)` with Bun's
`node:sqlite`, the binder of the off-mode store (the addon's shell, `native-sqlite.ts`,
reproduces its errors), and records `["unstorable"]` when that throws. `ColumnError::NotStorable`
must match exactly the values this oracle refuses: if it binds a kind the column table calls
unstorable (a boolean, say), or refuses one the table stores, stop and report it rather than
guessing. `changes` is null when `threadColumnChanges` throws, and `coldRow` is `coldRowValues` when `cold` is not empty. Numbers are recorded as
`String(n)`, so oxfmt never rewrites them. Before writing, the generator checks that every
`fieldSamples` value parses with its field's schema to the same JSON text, and exits non-zero
otherwise. `--check` regenerates in memory and fails on any difference; `check-daemon-native.ts`
runs it after `store-vectors.ts --check`.

`crates/ace-projection/tests/column_vectors.rs` (the `allow` line of `tests/vectors.rs`) checks,
for every case: each `values` entry that isn't rejected equals `column_value` (text by UTF-16
units, a number by `ace_json`'s printing against `String(n)`, null); an unstorable one is
`Err(ColumnError::NotStorable(column))`, and every `NotStorable` Rust returns is recorded
unstorable; a rejected one returns without panicking. When `changes` is not null, `column_changes` with `wanted` mapped through
`Column::from_name` gives the same `row`, `hot`, `cold` and `parts` in the same order, and
`cold_row_values` the same `coldRow`; when it is null, `column_changes` returns without
panicking.

Cases that must be present (the reviewer counts them):

- every case of `fold.json`, with `previous` its `thread`, `next` its `folded` and `wanted`
  `writtenColumns` of its event's payload (`previous` null for `thread.created`): the pairs the
  writer sees after a fold, with their lone surrogates, split pairs, `1e21`, `1.5e-7`, `-0`,
  `2^53 - 1` and array-index keys; its schema-invalid payloads give `rejected` values;
- for each field of the three shapes, absent to present, present to absent, and one legal value
  to another (client and acp fields at the thread's top level, details fields inside `details`).
  A field that accepts only one value gets absent and present only: `autoSettle` accepts only
  `false` and `settleWhenDone` only `true` (`thread-client.ts:109`, `:114`);
  `null` at every nullable path (`details.branch`, `head`, `upstream`, `linkedPr`,
  `workspace.icon`, `workspace.defaultIcon`, `pullRequestWorkspace.headRepository`,
  `live.rootRunId`, `live.contextMeter.limit`, `movedFrom.links.linkedPr`); `null` on one
  optional field of each schema that isn't nullable (rejected);
- unknown keys, among them `__proto__` and an array-index key, at the thread's top level and
  nested in `details.workspaceChange`, `details.pullRequestWorkspace.ref.repository`,
  `live.turnStart`, a `snoozeWake` `pr` entry, `acpSupport.raw` and
  `effectiveCapabilities.permissions`: all stripped;
- defaults: `workspaceChange` without `lossy` (`true` at its place, after `error`) and with
  `lossy: false`; `acpSupport` without `subagentSessions` (`false` after `modeSelection`) and with
  `true`; and `null` at both (`workspaceChange.lossy: null`, `acpSupport.subagentSessions: null`),
  which a default never replaces: the generator asserts that the TS rejects both (`["rejected"]`)
  and exits non-zero if it doesn't;
- unstorable values, judged by the bind oracle: `title` and `created_at` each absent, a boolean,
  an object and an array, and `status` absent;
- key order: every object level given in reverse schema order; `live.options` with keys out of
  order, an array-index key and `__proto__` (dropped);
- discriminated unions: every option of `snoozeWake` (`needs_you`, `pr`) and `snoozeWoke`
  (`time`, `needs_you`, `pr`), each with an unknown key; an unknown `on` (rejected);
- numbers: `1e21`, `1.5e-7`, `-0` and `2^53 - 1` in `pinOrder` and `listOrder`, and in
  `createdAt` and `updatedAt` (the number columns); `updatedAt` from `0` to `-0` (no change);
- strings: a lone surrogate and a split pair in `title`, `details.branch`, `live.model`,
  `acpAgentId`, a `live.options` key and an unknown key (stripped);
- compares: `details` with the same content in another key order (a change); a change only to a
  key no column reads (no change); `transitions` with a nested key-order change (a change); a new
  thread with neither cold column (no `cold`), with `details` only, and with
  `capabilities: null` (the text `"null"`); an existing thread changing only `capabilities`
  (`coldRow` carries `previous`'s details); `imported` absent, an object, and each falsy JSON
  value;
- `thread.updated` with and without `effectiveCapabilities`, `acpSupport` and `acp` (`wanted`
  with and without `acp`), and an `item.delta` (`wanted` empty).

**Proof:** `cargo test -p ace-protocol -p ace-projection`, `bun scripts/generate-rust-protocol.ts
--check`, `bun scripts/column-vectors.ts --check`, `bun scripts/store-vectors.ts --check` and
`bun run check:daemon-native`. The TypeScript moves change no behaviour; run these one at a time
in the two off modes (`ACE_STORE=native`, and plain): `thread-columns.process.test.ts`,
`store.test.ts`, `thread-cache.process.test.ts`, `thread-cold.test.ts`,
`revision-triggers.process.test.ts`, `thread-row-trust.test.ts`.

**Do not:** decode or print a value with the `typify` structs or `serde_json`; validate
(lengths, patterns, integers, formats, `refine`); widen the shape language past the refusals
above; edit `shapes.rs` or `columns.json` by hand; touch `thread-row.ts`; change any TS encoding;
add a test other than the vector test.

#### Step 5.3b-2: the column writes behind `columns`

**Files the builder may touch:** `packages/provider-kit/src/native-switches.ts` (the part
`columns`, after `events`, in the type, the order and its comment),
`native/daemon/crates/ace-store/` (`Cargo.toml` for `ace-json` and `ace-projection`,
`src/writer/mod.rs`, `src/writer/events.rs` for `WriteError::Column` only,
`src/writer/thread_columns.rs` new), `native/daemon/crates/ace-daemon-node/src/writer.rs`,
`native/daemon/Cargo.lock`, `apps/daemon/src/native-writer/thread-columns.ts` (new),
`apps/daemon/src/event-writer.ts` (`writeThread`, `:252` to `:289`, and imports),
`apps/daemon/src/thread-row-trust.test.ts` (the one new case below). Nothing else.

**Rust** `crates/ace-store/src/writer/thread_columns.rs`:

```rust
/// What `writeThread` wrote, for the shell's `rebuildThread`.
pub struct Written {
    pub row: Vec<(Column, ColumnValue)>,
    pub parts: Vec<Part>,
    /// No `previous`, or `threadRowConfirmed`, read before the writes.
    pub confirmed: bool,
    /// `SELECT revision FROM sidebar_thread_revisions WHERE thread_id = ?`; None when there is
    /// no row or the value isn't a number.
    pub revision: Option<f64>,
}
pub struct ThreadColumnWriter { /* cached statements only; no thread state */ }
impl ThreadColumnWriter {
    pub fn new(conn: &Arc<Connection>) -> Result<ThreadColumnWriter, crate::Error>;
    /// `writeThread` through the revision read; Ok(None) when no column changed.
    pub fn write(&mut self, conn: &Connection, previous: Option<&ace_json::Map>,
        next: &ace_json::Map, wanted: &[Column]) -> Result<Option<Written>, WriteError>;
}
```

In this order, as `writeThread` runs them:

1. `column_changes`; return None when `hot` and `cold` are both empty.
2. `confirmed`: true without `previous`, else the `threadRowConfirmed` SELECT
   (`thread-row-trust.ts:189`).
3. When `hot` is not empty: `UPDATE threads SET a = ?, b = ? WHERE id = ?`, one `name = ?` per
   hot column, joined with `", "`.
4. When `cold` is not empty:
   `INSERT INTO thread_cold (thread_id, details, capabilities) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET details = excluded.details`,
   one `name = excluded.name` per cold column, joined with `", "`, bound with `cold_row_values`.
5. The revision SELECT.

The SQL texts are the TS's, byte for byte. The UPDATE and the upsert are prepared on first use
and cached by their set of columns (a `u16` mask: within a set the order is always `wanted`'s,
which is fixed); every read is reset after its step, as 5.3a's review required. Binding: `Text` as
`Value::Text(to_string_lossy())` (a lone surrogate in a plain text column becomes U+FFFD, as
N-API and node:sqlite bind it; the JSON columns hold the ASCII escape `\ud800`); `Number` as
`Value::Real`, as 5.3a binds numbers; `Null` as `Value::Null`. The id is `next`'s `id`, bound the
same way. `WriteError` gains `Column(ColumnError)`, which displays its message.

**Binding** (`writer.rs`): `NativeDatabase::thread_column_writer()` returns a
`NativeThreadColumnWriter` holding the `Arc<Connection>` and the writer, with
`write(previous: Option<String>, next: String, wanted: Vec<String>) -> napi::Result<Option<String>>`.
`previous` and `next` are `JSON.stringify` texts (well-formed UTF-16, so safe as N-API strings),
parsed with `ace_json::parse`; malformed JSON throws `SyntaxError` through
`json_bind::syntax_error`, and a non-object or an unknown column name throws `Error`. The result
is null, or the JSON text `{"row":{...},"parts":[...],"confirmed":bool,"revision":number|null}` in
`Written`'s order, with values as JSON strings, numbers (printed by `ace_json`) and null. SQLite
errors leave through `fail()`, the others as plain `Error`s with their message (`write_error`, as
5.3a).

**Shell** `apps/daemon/src/native-writer/thread-columns.ts`, on the pattern of
`native-writer/events.ts`: one writer per `DatabaseSync` in a `WeakMap`, every call through
`nativeCall`, and on the process's first native write one line `${process.pid} columns` appended
to `ACE_STORE_WRITER_EVIDENCE` when it is set.

```ts
/** What a thread write stored, for `rebuildThread`. */
export interface ColumnsWritten {
  row: Record<string, ColumnValue>;
  parts: Set<ThreadPart>;
  confirmed: boolean;
  revision: number | undefined;
}
export function writeThreadColumns(
  db: DatabaseSync,
  previous: FrozenThread | undefined,
  thread: Thread,
  wanted: readonly ThreadColumn[],
): ColumnsWritten | undefined;
```

It sends `previous === undefined ? null : JSON.stringify(previous)`, `JSON.stringify(thread)` and
`wanted`, and `JSON.parse`s the result (`revision` null becomes undefined).

**`event-writer.ts`.** `writeThread` splits in two, the TS path unchanged. Its body from `:257`
to `:283` becomes a private `writeColumns(previous, thread, wanted): ColumnsWritten | undefined`,
returning undefined where it returns today; `writeThread` becomes:

```ts
const wanted = writtenColumns(payload);
const written = storeWriterOn("columns")
  ? writeThreadColumns(this.source.db, previous, thread, wanted)
  : this.writeColumns(previous, thread, wanted);
if (written?.revision === undefined) return;
// then :284 to :288 as they are, reading written.row, written.parts, written.confirmed and
// written.revision
```

**Switch value:** `ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,columns`.

**Proof, on and off:** rule 3's three runs, one file at a time; the on run writes an evidence
file, which must then hold a `columns` line:

```sh
f=apps/daemon/src/thread-columns.process.test.ts
test -f "$f" || { echo "missing $f"; exit 1; }
ev=$(mktemp)
ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,columns ACE_STORE_WRITER_EVIDENCE="$ev" \
  bun --bun x vitest run "$f" --maxWorkers=4
grep -q ' columns$' "$ev" || echo "no native column write in $f"
ACE_STORE=native bun --bun x vitest run "$f" --maxWorkers=4
bun --bun x vitest run "$f" --maxWorkers=4
rm -f "$ev"
```

The files, in `apps/daemon/src/`: `thread-columns.process.test.ts` (it folds with the TS
`updateThread` and compares with the threads the store reads back, after a restart and an
upgrade, so with `columns` on it checks Rust's columns against the TS decode), `store.test.ts`,
`stored-shape.test.ts`, `thread-cache.process.test.ts`, `revision-triggers.process.test.ts`,
`sidebar-columns.test.ts`, `thread-row-trust.test.ts` (a stamp stays only when the Rust write
reads the same as stored), `stored-trust-pass.test.ts`, `thread-cold.test.ts`,
`store-held-view-rollback.test.ts`, `store-auto-rollback.test.ts`,
`status-storage.process.test.ts`, `long-thread-lifecycle.process.test.ts`,
`thread-organization.process.test.ts` (snoozes, in `client`), `acp-identity.process.test.ts`
(`acp`), `workspace-move.process.test.ts` and `checkout-missing.process.test.ts` (`details`),
`engine/storage-behaviour.process.test.ts`, `daemon-crash-recovery.process.test.ts`. A file whose
evidence stays empty never wrote a thread through the store; the PR names it rather than dropping
it. If a file fails only with `columns` on, stop and report the test; don't change it.

**The one new test: a value Zod rejects rolls the write back.** The rejected vectors only show
that Rust survives such a value, and none of the files above makes Zod reject a column write, so
add one case to `thread-row-trust.test.ts`, named "a thread write Zod rejects leaves the row, its
revision and its trust stamp as they were". It uses the file's `setup`, `thread` and `forgeStamp`
helpers:

1. Create a thread. In `raw`, run
   `UPDATE threads SET client = json_set(COALESCE(client, '{}'), '$.autoSettle', json('true')) WHERE id = ?`
   (`autoSettle` accepts only `false`), then `forgeStamp`, so the next open reads the row as
   stored, invalid value included, as the existing "a confirmed row is read as stored" case does.
2. Open, and read with `peek`: the `client` text, the revision in `sidebar_thread_revisions`,
   the `thread_row_trust` row and the number of `events` rows.
3. Expect
   `store.appendEvents(id, [{ type: "thread.client.updated", changes: { pinned: true } }], 2)`
   to throw a `ZodError` (Zod's class, imported from `zod`).
4. Read the same four values again and expect each unchanged.

In the TS modes the encoder throws before any write; with `columns` on, Rust writes the copied
value, `rebuildThread` throws, and the transaction must undo the column, the revision bump and
anything done to the stamp. The case runs in all three modes with the rest of the file; it fails
if Rust's write survives, if `rebuildThread` is skipped, or if the throw is lost.

**Cross gate** (ADR 0223 §8): task 5.x-gate's file, with `columns` in the part list and a
`columns` line in its evidence check:

```sh
f=apps/daemon/src/store-cross-backend.process.test.ts
test -f "$f" || { echo "missing $f"; exit 1; }
ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,columns,live \
  bun scripts/native-cross.ts ACE_STORE_WRITER "$f"
```

A file that reopens the `Store` in one process (`thread-columns.process.test.ts`) fails the gate
as "reopens in-process" and is not a gate file.

**Bench:** `event-writes.ts` and `sqlite-store.ts --split` (commit p50 and p95), on and off. With
`columns` on, every event except `item.delta` stringifies two threads and crosses once. It stays
off unless its numbers are no worse, and may merge switched off with them in the PR (rule 10).

**Failure modes:** a value Zod rejects is written, then `rebuildThread` throws in the same
transaction, which rolls back with the event row; a `thread_cold` or `threads` write that fails
throws SQLite's error with its `errcode` (busy and retry handling branch on it), and the append
rolls back.

**Do not:** move `rebuildThread`, `keepThreadRowConfirmed` or the `remember*` calls; send the
payload across; call the native writer for `item.delta` (`writeThread` already isn't reached);
keep a thread or a previous encoding in Rust between calls; change any SQL text; add any test
but the case above.

**Reviewer checks, for both steps:** the encodings and the change loop against
`thread-columns.ts` line by line; the shape walk against the Zod behaviour above, and the
generator's refusals present; every vector case listed is there and the sample check runs;
`shapes.rs` and `columns.json` regenerate unchanged; no value goes through `serde_json` or a
`typify` struct; the statement order of `write` against `writeThread`, and the SQL texts byte for
byte; `rebuildThread` still runs on every Rust write that returns a revision, and the new
rollback case passes in all three modes; every unstorable vector is `NotStorable` and nothing
else is; the proof files
pass in all three modes, with the evidence line; the cross gate passes both ways; bench numbers
on and off in the PR; `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test` and
`check:daemon-native` pass.

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

Failure modes: a refill that fails or is pending leaves the batch pinned and unpublished
(task 5.2); a crash with buffered output loses only rows nobody saw as stored (replay of a
published-but-unstored cursor is refused by `replay_safe`, behaviour.md §11); a flush sealed
inside an open transaction is written once after rollback and never after commit; a retry
treats rows an earlier attempt committed (same seq and id) as stored; contention and a full disk
never count toward quarantine.

Do not: own a timer or thread in Rust; compact the held suffix; change the 4 KiB, 64 KiB, 8 MiB,
75 ms, 1 s, 100 ms, 5 s or 6 constants.

### Task 5.5: the transaction stack (`transactions`)

**Port** the stack in `store.ts` `transaction` (`:581` to `:678`) and its helpers
`recoverSavepoint`, `rollBack` and `settle` (`:679` to `:719`): depth, numbered savepoints,
`BEGIN IMMEDIATE`, `RELEASE`, savepoint recovery, the doomed flag, rollback, settlement
positions and the publication order. Port it to `writer/transaction.rs`. JavaScript closures
cannot run inside a Rust call, so the API is begin, then exactly one of succeed or fail per
frame:

```rust
pub type SettlementId = u64;
pub enum Settled { Committed, RolledBack }
/// What the caller runs, in order, after the stack has finished its SQL.
pub enum Step { Publish { from: usize, to: usize }, Settle { id: SettlementId, how: Settled } }
pub enum Ending { Released, Committed, RolledBackToSavepoint, RolledBack }
pub enum FinishError {
    /// COMMIT, RELEASE or a statement failed; the SQLite error, untranslated.
    Sqlite(ace_store::Error),
    /// "A failed step could not be undone, so the transaction rolled back", cause attached.
    Doomed(ace_store::Error),
}
pub struct Finish {
    pub ending: Ending,
    /// The caller truncates its event list to this length before running `steps`.
    pub events_len: usize,
    pub steps: Vec<Step>,
    /// Recovery failures (a failed ROLLBACK, a failed ROLLBACK TO): report, never throw.
    pub reports: Vec<ace_store::Error>,
    /// The error the caller throws after running `steps`; None for Released and Committed.
    /// When the caller's own `run` threw, it throws that instead and this stays None.
    pub error: Option<FinishError>,
    /// Bump `rollbackGeneration` and drop the read and sidebar caches.
    pub rolled_back: bool,
}
pub struct Frame { /* depth, savepoint name, events_len and settlements_len at begin, own outcome */ }
impl TransactionStack {
    /// BEGIN IMMEDIATE at depth 0, else SAVEPOINT nested_<n>. Err: nothing was opened and there
    /// is nothing to clean up.
    pub fn begin(&mut self, conn: &Connection, own: Option<SettlementId>) -> Result<Frame>;
    /// The caller's event list grew to `len` (events written inside the open transaction).
    pub fn note_events(&mut self, len: usize);
    /// `run` returned. Never returns Err: every failure is in `Finish`, and on any failure the
    /// stack has already rolled back (to the savepoint, or the whole transaction).
    pub fn succeed(&mut self, conn: &Connection, frame: Frame) -> Finish;
    /// `run` threw. Never returns Err.
    pub fn fail(&mut self, conn: &Connection, frame: Frame) -> Finish;
}
/// For Rust callers: begin, run, then succeed or fail, returning the Finish.
pub fn atomic<T>(stack: &mut TransactionStack, conn: &Connection, own: Option<SettlementId>,
    run: impl FnOnce(&Connection) -> Result<T>) -> (Option<T>, Finish);
```

**One owner for each piece of state.** The stack owns depth, the doomed error, the event-range
positions and the list of pending settlements (id and position). The TypeScript shell owns the
`Event` objects and the settlement callbacks, in a map keyed by `SettlementId`. It applies
`events_len` and `steps` exactly as given and holds no position of its own.

**The rules, as the TS has them** (the reviewer checks each against `store.ts`):

1. Top-level success: if doomed, roll back and finish with `FinishError::Doomed`. Else `COMMIT`.
   On commit failure, roll back (unless SQLite already did, `is_transaction` false) and finish
   `RolledBack` with `FinishError::Sqlite`. On commit success the steps are, in order:
   `Settle { own, Committed }` if the frame has its own outcome; then, for each pending
   settlement in order, `Publish { from, to: settlement.at }` (only when the frame has no own
   outcome), then `Settle { id, Committed }`; then a final `Publish { from, to: events_len }`
   (only when the frame has no own outcome). A frame with its own outcome publishes none of its
   events (outer-outcome suppression, `store.ts:653` to `:660`).
2. Top-level failure (`fail`, or a failed commit): roll back if SQLite has not, report a failed
   `ROLLBACK` in `reports`, then `Settle { id, RolledBack }` for every pending settlement in
   order. The frame's own outcome is **not** settled: the caller sees the error and handles it,
   as `store-stream.ts` `write` does today.
3. Nested success: `RELEASE`. If the frame has its own outcome, events recorded since the
   frame's begin are cut from the publish range (`events_len` = the frame's begin length), and
   the outcome joins the pending list at that position. It settles when the outermost frame
   settles. No steps now.
4. Nested failure: `ROLLBACK TO` and `RELEASE` the savepoint. With no open transaction, the
   savepoint cannot be undone: set doomed (first error kept) and add **no** recovery report, as
   `store.ts:671` and `:752` do. If the `ROLLBACK TO` statement itself fails, report that
   failure through `onError` (`recoverSavepoint`'s quiet report) and set doomed too. `events_len`
   = the frame's begin length. `Settle { id, RolledBack }` for every settlement registered since
   the frame began, in order. The frame's own outcome is not settled, because it never joined the
   list. `rolled_back` is true.
5. Exactly once: every `SettlementId` that joins the pending list appears in exactly one
   `Settle` step, ever. An id never joins twice.

The TypeScript `Store.transaction` keeps the flush before begin, the history-installation inline
path, the `Promise` check (`Store transactions must be synchronous`), the thread cache
(`begin`, `discard`, `commit`, `end`), the read and sidebar caches, `writtenThreads`, the WAL
wake, `transactions++`, `eventRows`, `publishFresh` (it filters at or below `publishedSeq`), the
usage listeners, and running `steps` (each `Settle` callback in its own try, as `settle` does).
Shell: `apps/daemon/src/native-writer/transaction.ts`, selected inside `transaction`.

**Errors out of `Finish`.** `nativeCall` (rule 11) only translates errors the addon throws, but
`succeed` and `fail` return SQLite failures as data. So the binding serialises every
`ace_store::Error` in `Finish` (`error` and `reports`) as the same
`{kind, errcode, message, errstr}` object `fail()` puts after `ace-store:`. In
`packages/provider-kit/src/native-sqlite.ts`, the error-building half of `rethrow` (`:82`)
becomes an exported `sqliteError(failure): Error`, which returns the `SqliteError` instead of
throwing it, and `rethrow` calls it. The shell then runs, in this order:

1. Truncate its event list to `events_len`.
2. Run `steps`, each `Settle` callback in its own try, reporting a throw through `onError`.
3. Report each entry of `reports` through `onError` as `sqliteError(entry)`.
4. Throw:
   - when the caller's `run` threw, that same JavaScript exception, unchanged;
   - else for `FinishError::Sqlite`, `sqliteError(error)`, so `errcode` and `errstr` reach
     `isStoreBusy` and `isStoreRetry` as they do today;
   - else for `FinishError::Doomed`,
     `new Error("A failed step could not be undone, so the transaction rolled back", { cause })`,
     where `cause` is the JavaScript exception the nested `run` threw (`store.ts:605`:
     `this.doomed ??= error`). Rust only knows that the frame is doomed, so `FinishError::Doomed`
     carries no error. The shell keeps the first nested exception for which `Finish` reported a
     new doom, and clears it when the outermost frame finishes (`store.ts:625` to `:628`).

**Proof, on and off:** `store.test.ts`, `store-auto-rollback.test.ts`,
`store-held-view-rollback.test.ts`, `store-live-write-recovery.test.ts`,
`store-read-cache.test.ts`, `thread-cache.process.test.ts`, `sidebar-columns.test.ts`,
`payloads.process.test.ts`, `history-storage.process.test.ts`,
`history-publication-recovery.process.test.ts`, `wal-maintenance.process.test.ts`,
`daemon-crash-recovery.process.test.ts`, `storage/recovery.process.test.ts`. Bench:
`sqlite-store.ts --split` (commit p50 and p95), `event-writes.ts`.

**Failure modes:** `SQLITE_FULL` or an I/O error that makes SQLite roll the whole transaction
back inside a savepoint (`is_transaction` false, so the savepoint cannot be undone, which dooms
the outer frame); a crash mid-transaction (uncommitted WAL frames are discarded, nothing was
published); a throw from a settlement callback (the shell reports it, and the transaction stays
settled).

**Placement:** when no TypeScript calls `Store.atomic` any more (ADR 0223 §4), the stack and
the connection move to one core thread. `TransactionStack` is unchanged; only the binding is
replaced.

### Task 5.x-gate: the two-process cross gate for the store

ADR 0223 §8 and ADR 0222 need a home written with a writer part on to reopen correctly with it
off, and back. `ACE_STORE` and `ACE_STORE_WRITER` take their value once per process
(`processBoot`, `native-switches.ts:384`), and `scripts/native-cross.ts` (since `be04f1a019`)
compares the backend each boot actually ran. Under it, eight of the nine store files we used fail
as "reopens in-process": `engine/storage-behaviour.process`, `store`, `revision-triggers.process`,
`thread-columns.process`, `sidebar-columns`, `thread-row-trust`,
`engine/live-write-buffer.process` and `store-live-write-recovery`. Each reopens the `Store` in
the vitest worker, so its second boot runs the first boot's backend. The existing restart helpers
don't help: `engine/recovery-test-support.ts` `restart` builds a new `Engine` over the same open
`Store` (no reopen at all), and `crashCopy` opens a backup in the same process.

`history-publication-recovery.process` passes because its import runs in a `worker_threads`
`Worker`. A worker loads its own copy of `native-switches.ts`, so its `processBoot` starts empty
and its boot takes the opposite value. The gate only checks the pid when the alternation is
wrong, so the shared pid doesn't matter. That is a split between realms, not processes: the
addon is loaded once and shared, a worker can't be killed mid-transaction the way a process can,
and the worker only writes history imports. So the writer items merged so far (5.1, 5.2b, 5.3a,
5.4a, 5.4b) have no real cross-mode proof yet.

**Decision: option (a), one new process test, run by the gate.** The test never opens a `Store`
itself. Every boot of its home is a separate child process (`spawn` of `process.execPath`, the
same runtime as the worker) that opens the home with `new Store(path)`. Under `native-cross.ts`,
each child is a fresh process, so it takes the backend the boot log gives boot _n_, and the gate's
per-root assertion passes for real. Run plainly, every child inherits the same switch, so the file
is a crash-and-restart test across processes in each of rule 3's three modes. The boot log,
`ACE_NATIVE_CROSS` and `ACE_NATIVE_CROSS_LOG` already reach the worker through
`scripts/test-home-policy.ts`, and the children inherit them. The gate needs one small change
(G0, below) so its starting-off run uses the full part list. children inherit them. Rule 2 allows this new file as "a test for behaviour nothing covers
today", named here: a home crossing backends between processes. It is the one new
`*.process.test.ts`, and its real edge is process death. The other two options were rejected:

- (b), running two halves of a file in two vitest runs: the halves would have meaningless plain
  runs, assertions would be split across runs, and the gate would need a new protocol;
- (c), reusing a restart harness: none of them restarts in a new process except the daemon CLI
  tests, which boot a whole daemon to write a handful of rows.

Later store items (5.3b-2 `columns`, 5.5 `transactions`, 5.3c onward) reuse this file as their
gate (step G3).

**The phases.** One home, six children in this order:

| Boot | Phase                      | Ends with                                                  |
| ---- | -------------------------- | ---------------------------------------------------------- |
| 0    | `write`                    | clean `close()`                                            |
| 1    | `crash-in-transaction`     | SIGKILL inside `Store.atomic`, after writes, before commit |
| 2    | `crash-in-transaction`     | the same, in the other mode                                |
| 3    | `crash-with-buffered-tail` | SIGKILL with published live deltas still buffered          |
| 4    | `crash-with-buffered-tail` | the same, in the other mode                                |
| 5    | `final`                    | clean `close()`                                            |

**Both directions with the full part list (gate change G0).** Today the gate's opposite of an unset
`ACE_STORE_WRITER` is `fold` (`native-switches.ts:369`). So the starting-off run would turn on only
`fold`, and in the starting-on run the on boots are always 0, 2 and 4: an on crash in a
transaction always follows a crash, and an off one always follows a clean boot. G0 makes the
starting-off run alternate between off and the same list the starting-on run uses:

- `scripts/native-cross.ts`: for `ACE_STORE_WRITER`, the starting-off run sets
  `ACE_STORE_WRITER_CROSS` to the starting-on value of `ACE_STORE_WRITER`, then deletes
  `ACE_STORE_WRITER` as it does today. The usage line says so.
- `packages/provider-kit/src/native-switches.ts`: `opposite("ACE_STORE_WRITER", "")` returns
  `process.env.ACE_STORE_WRITER_CROSS ?? "fold"`. The value is checked at module load with the
  same unknown-part and prefix rules as `ACE_STORE_WRITER`, and the same `needs ACE_STORE=native`
  refusal. Export `canonicalWriterParts(value: string | undefined): string`: `parseWriterParts`
  (`:129`), then the parts in `writerPartsOrder` (`:120`), joined by `,`. It throws what
  `parseWriterParts` throws. So `" events, fold,sequences,fold "` gives `"fold,sequences,events"`,
  and `undefined` or `""` gives `""`.
- `scripts/test-home-policy.ts`: pass `ACE_STORE_WRITER_CROSS` through, next to
  `ACE_STORE_WRITER`.
- `native-switches.test.ts`: one case in the existing cross-switch tests. With
  `ACE_STORE_WRITER_CROSS=fold,sequences` and an unset `ACE_STORE_WRITER`, boot 1 runs
  `fold,sequences`, and an unknown or non-prefix value refuses to start.

With G0, the starting-on run is on, off, on, off, on, off and the starting-off run is off, on, off,
on, off, on, with the same parts. Each crash kind then runs in each mode after both a clean boot and
a crash.

**The test checks the modes itself, because the gate accepts any alternation.**
`assertAlternation` (`native-cross.ts:115`) only checks that a boot's effective value equals or
differs from boot 0's. An empty `parts` list would also pass the evidence check vacuously. So the
test computes each boot's expected mode from its own environment and asserts it exactly:

```ts
const cross = process.env.ACE_NATIVE_CROSS;
const start = canonicalWriterParts(process.env.ACE_STORE_WRITER);
const other =
  start === "" ? canonicalWriterParts(process.env.ACE_STORE_WRITER_CROSS ?? "fold") : "";
const parts = (n: number) => (cross === "ACE_STORE_WRITER" && n % 2 === 1 ? other : start);
const native = process.env.ACE_STORE === "native";
const backend = (n: number) =>
  (cross === "ACE_STORE" && n % 2 === 1 ? !native : native) ? "native" : "typescript";
```

Both sides are canonical, so reordered, padded or repeated parts in the environment can't fail
the check: the child reports `parts` as `canonicalWriterParts([...storeWriterParts()].join(","))`.
Each report's `parts` must equal `parts(n)`, and its
`backend` must equal `backend(n)`. The six `pid`s must be distinct and none may be the test's own.
For evidence, a boot with parts has exactly one line per part and no others, and a boot without
parts has none.

**Files the builder may touch:**

- G0: `scripts/native-cross.ts`, `packages/provider-kit/src/native-switches.ts`,
  `packages/provider-kit/src/native-switches.test.ts`, `scripts/test-home-policy.ts`;
- G1, a pure move: `apps/daemon/src/store-cross-test-support.ts` (new),
  `apps/daemon/src/thread-columns.process.test.ts`, `apps/daemon/src/store-live-writes.test.ts`,
  `apps/daemon/src/thread-row-trust.test.ts` (imports only, plus deleting what moved);
- G2: `apps/daemon/src/store-cross-child.ts` (new),
  `apps/daemon/src/store-cross-backend.process.test.ts` (new).

Nothing else. No `Store` source file changes, and no `scripts/test-budgets.json` entry.

#### Step G1: move the assertions the gate reuses (no behaviour change)

Move these into `store-cross-test-support.ts`, exported, with no change to what they compute:

- from `thread-columns.process.test.ts`: `random(seed)`, `Window`, `persisted`, `snapshot`,
  `withoutRevision`, and from `runSeed` the event generator (`event(id)`), the direct-SQL writer
  (`direct(id)`), the fold (`fold`), the per-step `check(label, changed)` and the step loop body
  (direct write, rolled-back `atomic`, the raw `BEGIN IMMEDIATE`…`ROLLBACK`, folded appends).
  Shape them as one driver:

  ```ts
  export interface Assertions {
    /** `expect(a, label).toEqual(b)` in vitest; deep-equal after a JSON round trip in a child. */
    equal(actual: unknown, expected: unknown, label: string): void;
    /** `expect(a, label).toStrictEqual(b)`; `assert.deepStrictEqual` in a child. */
    strictEqual(actual: unknown, expected: unknown, label: string): void;
    /** `expect(run).toThrow(message)`; `assert.throws(run, { message })` in a child. */
    throws(run: () => unknown, message: string): void;
  }
  export interface StreamState {
    seed: number;
    ids: ThreadId[];
    items: Record<string, ItemId[]>;
    workspaces: WorkspaceId[];
  }
  /** Creates `count` threads with root agents, as `runSeed` does, and returns the state. */
  export function createThreads(
    store: Store,
    dir: string,
    seed: number,
    count: number,
  ): StreamState;
  export function threadStream(
    store: Store,
    db: DatabaseSync,
    state: StreamState,
    assert: Assertions,
  ): {
    windows: readonly Window[];
    /** Runs one step of `runSeed`'s loop, then `check`. */
    step(label: string): void;
    check(label: string, changed: ReadonlySet<string>): void;
  };
  ```

  `fold` keeps `updateThread` from `@ace/projection` as its reference. `folded` starts from the
  store's threads: `getThread(id)` for each id, which is what `runSeed` does after a direct
  write, plus every other thread the home holds, so a boot that reopens a home with threads it
  did not create folds them too. The rng draws stay in `runSeed`'s order, so seeds 11 to 13
  replay the same streams;

- from `store-live-writes.test.ts`: `answerText` and `snapshotText`, with the item id as a
  parameter (`"answer"` at the existing call sites), and `stream` (`prepareLiveWrite` +
  `bufferLiveWrite` with the `unpinned` snapshot);
- from `thread-row-trust.test.ts`: `confirmedSql`, used where it is today.

Add three new helpers beside them: `disk(path): Disk`, `copyHome(home, into)` and
`diskCopy(into): Disk`. `disk` opens
its own read-only `DatabaseSync` from `@ace/provider-kit/sqlite` — the process's own SQLite
library (ADR 0222), so a native store's file is never held by two libraries — the same observer
in every mode, reads, and closes. It is used only while a `Store` holds the home, as
`engine/live-write-buffer.process.test.ts:269` does. A reader then neither recovers nor
checkpoints the WAL. The observer never opens a home that no live `Store` holds: a connection
opened there could recover and checkpoint the WAL, and the next backend would then never see the
WAL it has to recover. For a home nobody holds, `copyHome` copies `events.sqlite` and
`events.sqlite-wal` (when present; never `-shm`) into a fresh directory `into`. Later,
`diskCopy(into)` opens the copy writable, so SQLite can recover the copied WAL there, reads,
closes and deletes the copy. `disk` and `diskCopy` return, each in a fixed order:

```ts
type Disk = {
  events: { seq: number; id: string; thread_id: string; type: string; payload: string }[]; // ORDER BY seq
  hostSequence: number; // SELECT seq FROM host_sequence WHERE id=1
  recent: { workspace_id: string; opened_at: number }[]; // workspace_recent, ORDER BY workspace_id
  threads: Record<string, unknown>[]; // SELECT * FROM threads ORDER BY id
  cold: Record<string, unknown>[]; // SELECT * FROM thread_cold ORDER BY thread_id
  revisions: { thread_id: string; revision: number }[]; // sidebar_thread_revisions, ORDER BY thread_id
  stamps: Record<string, unknown>[]; // SELECT * FROM thread_row_trust ORDER BY thread_id
  walBytes: number; // size of events.sqlite-wal, 0 if missing
};
```

`Store.readEvents` flushes the live buffer (`store.ts:1174`), so the child never uses it to
observe a buffered tail. Every on-disk check below goes through `disk`.

Proof: the three source files pass, unchanged in count and names, in all three modes (rule 3).
G1 is its own commit, and G2 starts from it.

#### Step G2: the child and the test

**`store-cross-child.ts`** is a script, run as
`process.execPath store-cross-child.ts <boot> <phase> <home> <previous-report|-> <report>`. It
imports `Store` from `./store.ts`, `storeWriterParts` and `storeBackend` from
`@ace/provider-kit/native-switches`, and the support module. It uses `node:assert` for the
`Assertions` (never vitest). A failed assertion or a failed precondition exits 1 with the message.
The report is written with `writeFileSync`, as the last thing before the child exits or kills
itself. Thread ids, item ids and `at` values below are fixed, never drawn from the clock. In order:

1. Every boot except 0 (where the home and its tables don't exist yet): `copyHome` before anything
   opens the home. Then `new Store(path)` opens the original first, so
   the target backend does its own WAL recovery. Only after that does the child read the copy as
   `preOpen = diskCopy(...)`. The copy is taken before the open and read after it, so `preOpen`
   is what the previous process left, untouched by either the observer or the new backend.
   Right after the open, before any test write, also compare a full
   `Store.readEvents({ afterSeq: 0, limit })` of the target Store against that copy's events
   (`seq`, `id`, `thread_id`, `type`, and the parsed payload)
   (`store.ts:1174`). `preOpen` comes from the copy, so without this the events the target
   backend recovered from the WAL are never read through the store that recovered them. The copy
   stays the source for the pre-open column and trust-stamp checks.
2. With the store open (`new Store(path)` above; at boot 0, the first open),
   `db = store.atomic((db) => db)`. Record `pid`, `parts` and `backend`, read after the open, since the value is fixed at this boot. Subscribe with
   `store.subscribe` and record every published event's `seq` as `published`.
3. Every phase except `write` records `opened = observe(store)` before it writes anything:
   - `snapshot(store, windows)` and `getThread(id)` for every id (the cache path);
   - `headSeq()`;
   - `snapshotText` for each live item.

   After a tail crash it also opens a probe on the lost thread: `subscribe(store, "probe",
{ kind: "thread", threadId }, previous.lostThrough, 1000, push)`, closed at once. The first
   message type goes in the report as `probeFirst`.

4. **The required writes**, committed, in this order, in every boot. Shrinking the workload never
   removes them:
   1. `write` only: 3 workspaces and 10 threads (`createThreads`, seed 21), and two threads'
      message items for live output.
   2. `thread.created` for `recent-<boot>` in `workspaces[boot % 3]`, at `4e12 + boot`. That is
      later than any clock, so `workspace_recent` must then read exactly that `opened_at`
      (`event-writer.ts:178`).
   3. `thread.created` for `imported-<boot>` with `imported` set (the shape in
      `engine/metadata-commands.process.test.ts:26`) in `workspaces[(boot + 1) % 3]`, at
      `5e12 + boot`. It must not change `workspace_recent`.
   4. `agent.created`, `origin` `"root"`, on `recent-<boot>` (fold rule 4).
   5. `queue.updated` on thread 0 (fold rule 1).
   6. `thread.client.updated` on thread 1, with `pinned`, `details` and `live` in one change
      (fold rule 2; `client` and `thread_cold` columns).
   7. `thread.updated` on thread 2, with `title`, `status` and `capabilities` in one change
      (fold rule 3; the hot columns, `provider_metadata` and `thread_cold`).

   Then `requiredDisk = disk(...)` (read-only).

5. 60 `threadStream` steps with seed `21 + boot`. Thread state comes from the previous report
   (`state`), and new item ids take a `b<boot>-` prefix. The home never holds more than 25
   threads, so each step's `check` stays bounded (O(threads × 4 windows)). History-sized reads
   happen only in `disk` and `observe`, at most four times per child.
6. **The live bursts.** Each burst is one fixed script, the same in every boot, on a fresh message
   item `live-<boot>-<k>`, created and committed before it. Each is issued in one synchronous turn,
   so compaction sees the same input in every mode:
   1. 40 deltas of 10 to 200 bytes from a fixed list, with another thread's deltas in the same
      turn, so a row merges many inputs and the batch one flush sees holds two threads. The list
      is chosen against the buffer's own limit: an event weighs `8 × JSON bytes + 512` and the
      buffer flushes at 64 KiB (`live-write-buffer.ts:155`), which this batch reaches partway
      through in every mode. The list makes that flush land on the same append for a three- to
      six-digit sequence, so the compacted row boundaries don't drift between boots. The
      4,096-byte merge rule cannot be reached here: 4,096 bytes of appends of 200 bytes or less
      weigh more than 64 KiB before they can merge, so that rule stays proven by
      `store-live-write-recovery` and the compaction tests. The other thread's deltas follow
      burst 1's run, because compaction only merges adjacent events;
   2. a surrogate pair split across two appends (`"\ud83d"` then `"\ude00"`), and a lone
      `"\ud800"`;
   3. the threshold burst, written so its compacted rows are known without recomputing compaction.
      It is `N` separate `stream` calls in one turn, each one delta of exactly 3,000 ASCII bytes
      (`String.fromCharCode(65 + i % 26).repeat(3000)` for call `i`). Two adjacent deltas total
      6,000 bytes, over the 4,096-byte merge limit, so no two merge, and each stored row is
      exactly one input with that input's own seq. `N` is a constant in the child: the first
      count whose last call makes the buffer's weight reach 64 KiB (`live-write-buffer.ts:155`).
      The builder measures it once in TypeScript mode and writes it in. Preconditions, checked
      with `disk` after every call: after calls 1 to `N` − 1, none of the burst's seqs are on
      disk; after call `N`, all `N` are, with no explicit flush. Any other result fails the child
      as "threshold burst did not flush on its final append". Then, still before any explicit
      flush, the burst's stored rows must be exactly the `N` inputs, in order, with their
      published seqs and appends;
   4. a delta on a different `field`, then one on the item's first field.

   Each burst's input script is a constant, so its expected text is derived from the inputs:
   per item and field, the join of the script's appends. Nothing records what was stored to
   compare against itself. After bursts 1, 2 and 4, call `store.flushLiveWrites()`. Then record,
   per burst, `rows`: its stored `item.delta` rows from `disk`, as
   `[{ seq, field, append }]` in seq order (the compacted rows). A merged row keeps the last seq
   of its span (`live-write-buffer.ts:249`), so a row's seq is not checked against each input's
   seq, except in burst 3, where nothing merges.

   The first burst of every boot refills the sequence range, because `initialize` sets the
   reservation to `host_sequence` (`stream-sequences.ts:46`), so the first `prepare` after an
   open reserves `65536` more (`:83`). Crossing an exhausted range inside one boot takes 65,536
   events. That stays proven per mode by 5.2a's test in `store-live-write-recovery.test.ts`, not
   by the gate.

7. The ending:
   - `write`, `final`: `flushLiveWrites()`, then `closed = observe(store)`, then
     `await store.close()`. Then `copyHome` and `durable = diskCopy(...)` (the home is no longer held), and the
     child writes the report and exits 0.
   - `crash-in-transaction`:
     1. `flushLiveWrites()`, then `durable = disk(...)` and `closed = observe(store)`.
     2. Control the WAL, because whether uncommitted pages reach it depends on SQLite's cache and
        on WAL space being reused. On the store connection, run
        `PRAGMA wal_checkpoint(TRUNCATE)` (it must report `busy = 0`), then
        `PRAGMA cache_size = -256`, then `PRAGMA cache_spill = ON` (node:sqlite's build defaults
        the spill threshold to 20,000 pages, and the addon's newer SQLite reads `0` as "never
        spill", so the cache size alone never reaches the WAL). Read `walBefore` from `disk`; it
        must be 0.
     3. Inside `store.atomic`: create thread `crash-<boot>` in `workspaces[boot % 3]` at
        `6e12 + boot`, append 64 `item.created` events of 64 KiB of text each to thread 3, and a
        `thread.updated` title on thread 4.
     4. Still inside the transaction, read `walInside` from `disk`. If it isn't greater than 0,
        exit 1 with "precondition: no uncommitted frames reached the WAL".
     5. Write the report (`crashing: "transaction"`) and call
        `process.kill(process.pid, "SIGKILL")` inside the callback.
   - `crash-with-buffered-tail`:
     1. `flushLiveWrites()`, then `durable = disk(...)` and `closed = observe(store)`.
     2. `stream` 5 deltas, under 1 KiB in all, to `tail-<boot>`, a message item created and
        committed empty before step 1. Don't flush.
     3. In the same synchronous turn, check the preconditions and record them:
        - `published` holds all 5 tail seqs. `lostFrom` and `lostThrough` are the first and last;
        - `store.hasLiveWrite(threadId)` is true;
        - `killDisk = disk(...)` holds none of the 5 seqs, and `killDisk.hostSequence` is at
          least `lostThrough` (the reservation covers what was published).

        If any precondition fails, exit 1 naming it.

     4. Write the report (`crashing: "tail"`) and call `process.kill(process.pid, "SIGKILL")` in
        the same turn.

**`store-cross-backend.process.test.ts`** has one test: "a home written in one process reopens
in another with every read, sequence and live delta intact, after clean closes, a kill inside a
transaction and a kill with a buffered tail". It makes a temp home and an evidence file. It runs
the six children in order, each with `{ ...process.env, ACE_STORE_WRITER_EVIDENCE: evidence }`
and no other env change, and collects stdout and stderr. It asserts the modes as above. Then, for
each boot _n_ > 0, against report _n_ − 1 (`prev`):

1. **Exit.** `write` and `final` exit 0. A crash phase exits by `SIGKILL` (on win32, exit code 1),
   and its report says `crashing`. On any other exit, fail with the child's stderr.
2. **The disk is what the previous mode left.** `preOpen` `toStrictEqual` `prev.durable`, except
   `walBytes`. After a tail crash it also equals `prev.killDisk` (except `walBytes`): no tail row
   reached SQLite, and `host_sequence` didn't move. This covers every column, revision, cold row,
   stamp and recency row the other mode wrote.
3. **Reads survive the crossing.** `opened` `toStrictEqual` `prev.closed`: the threads, the
   sidebar windows with their `window.revision`, the cache reads, `headSeq` and every live item's
   text. These are `thread-columns`' restart assertion
   (`expect(snapshot(store, windows)).toStrictEqual(before)` and the `getThread` loop),
   `thread-row-trust`'s "threads this build wrote read back after a restart exactly as they
   were", and `store-live-writes`' "survives reopen".
4. **The killed transaction left nothing.** `crash-<n-1>` isn't in `preOpen.threads`, and no
   `workspace_recent` row has `opened_at` `6e12 + (n-1)`. `prev.walInside > 0` and
   `prev.walBefore === 0`: uncommitted frames were on disk when the process died.
5. **Sequences continue.** Within `preOpen.events`, seqs strictly increase. Every seq boot _n_
   stored or published is greater than `prev`'s on-disk `host_sequence` (the persisted
   reservation, not just its last published seq). So the next allocation clears the whole
   reserved range, and a recovery that shrank it fails. After a tail crash, `probeFirst` is
   `"snapshot"`. This is `engine/live-write-buffer.process`' "restart never reuses a sequence
   already delivered by a lost buffered tail" and its `messages[0]` assertion, across a process
   boundary.
6. **No lost or duplicated deltas.** For each burst item, `opened`'s `snapshotText` (the `text`
   field) and, per field, the join of its stored `item.delta` appends in `preOpen.events` equal
   the join of the burst script's appends for that field. That expectation comes from the inputs,
   so a dropped or doubled append fails. The tail item `tail-<n-1>` (created and committed empty
   before the tail) reads `""` in `opened` and has no `item.delta` row in `preOpen`. Compacted
   rows: for each burst _k_, the `[field, append]` pairs of `rows[k]` are identical in all six
   reports, whichever mode wrote them, and at least one row of burst 1 holds more than one input
   append. In burst 3, `rows[3]` equals the `N` inputs one to one.
7. **The required writes landed, with their columns and stamps.** In `requiredDisk` of every boot,
   check the following against that boot's `preOpen` (at boot 0, against an empty home: every
   revision counts as higher):
   - `workspace_recent` for `workspaces[n % 3]` reads `4e12 + n`, and the imported workspace's row
     is unchanged;
   - threads 0, 1 and 2 have a higher `revisions` entry than in `preOpen`, their columns hold the
     values written in step 4, and each has a `stamps` row at exactly its new revision;
   - `requiredDisk.events` from this boot holds one each of `thread.created` (×2),
     `agent.created`, `queue.updated`, `thread.client.updated` and `thread.updated`, in that
     order.

   Assertion 2 then shows the next mode found those same stamps before its open could confirm
   anything (`store.ts:376` confirms recent rows at open, so checking ids after the open would
   hide a missing stamp).

8. **Revisions move forward.** In `closed`, each sidebar window's revision is at least its revision
   in `opened`, and greater for a window whose threads the phase changed.

Inside each child, every `threadStream` step runs `check` (cache vs fresh row vs the TS fold, and
live sidebar windows vs a full read), as `thread-columns` does.

**Proof (G2):** the file passes in all three modes of rule 3, then under the gate, both ways. Time
every run:

```sh
f=apps/daemon/src/store-cross-backend.process.test.ts
test -f "$f" || { echo "missing $f"; exit 1; }
time (ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,live bun --bun x vitest run "$f" --maxWorkers=4)
time (ACE_STORE=native bun --bun x vitest run "$f" --maxWorkers=4)
time (bun --bun x vitest run "$f" --maxWorkers=4)
time (ACE_STORE=native ACE_STORE_WRITER=fold,sequences,events,live bun scripts/native-cross.ts ACE_STORE_WRITER "$f")
time (ACE_STORE=native bun scripts/native-cross.ts ACE_STORE "$f")   # ACE_STORE_WRITER unset
```

Each gate run prints "1 rebooted root(s) alternated" for both starting values. Vitest's own
duration for the file must be at most 30 s in every one of these runs. If it isn't, lower the
`threadStream` step count, never below 20, and never the required writes, the bursts or the
phases. If 20 steps still don't fit, stop and report the timings. The PR lists every duration.

**If the gate fails on today's parts**, that is a cross-mode bug in a merged item, not in the
gate. Stop, and report the failing assertion, the boot, its `parts`, and the previous boot's. The
fix is a test-first PR for that item, and the gate PR stays as it is.

#### What each merged item changes, so the workload covers it

| Item                       | Writes it changes                                                                                                                                                                                                       | Covered by                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 `fold`                 | The thread projection `EventWriter` stores (`event-writer.ts:170`): queue, client and thread updates, `updatedAt`/`seq` stamps, the root agent id. Through those, the `threads` row, its revision and the sidebar facts | required writes 4.4 to 4.7 (one per fold rule), `threadStream` folded against the TS `updateThread` every step; assertions 2, 3, 7 and 8                                            |
| 5.2b `sequences`           | `host_sequence` reservations at live admission (`prepare`), the cursor and confirmed range, and `replaySafe` after a restart                                                                                            | each boot's first burst (a refill), the tail crash's `killDisk.hostSequence`; assertions 2 and 5                                                                                    |
| 5.3a `events`              | The `threads` insert and `workspace_recent` at `thread.created` (none for an imported thread), every `events` row and its `host_sequence` `MAX` update                                                                  | required writes 4.2 and 4.3, `crash-<n>` in the killed transaction, every stream step; assertions 2, 4, 5 and 7                                                                     |
| 5.4a `live` (pure)         | Which `item.delta` rows are stored, through compaction (merge rule, 4096-byte check, split pairs, lone surrogates), and the retry delays                                                                                | bursts 1, 2 and 4 on fixed input in every mode; assertion 6 (texts, and row boundaries identical across modes)                                                                      |
| 5.4b `live` (buffer state) | When rows are stored: the 64 KiB flush-now, the 75 ms and 1 s deadlines, pinning, `committed` and `rearm`, and so what a crash loses                                                                                    | burst 3's exact rows on disk after its final append and before any explicit flush, and the tail crash (published, unstored, never reused, refused on replay); assertions 2, 5 and 6 |

Retries and quarantine (`live-retry`, `live-discard`) stay proven by `store-live-write-recovery`
and `engine/live-write-quarantine.process` in each mode. They don't change what a crossing
reads, so the gate needs no fault injection.

#### Step G3: run it on what is merged

In every writer task's proof, the cross gate is the G2 gate commands with that task's parts
(5.3b-2's paragraph already says so). A later part adds its evidence kind and, if its writes aren't
covered yet, a required write in step 4, never a new gate file. The daemon CLI files
(`daemon-crash-recovery.process`, `daemon-stop-restart.process`) stay gate files for
`ACE_SUPERVISOR`, not for the store. The G2 PR runs the gate for the merged parts
(`fold,sequences,events,live`) and for `ACE_STORE`, and pastes both outputs. Only then do 5.1 to
5.4b count as proven across modes.

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
9. The two-process cross gate (task 5.x-gate) passes, starting on and starting off, with the
   task's parts, within 30 s per run, and the task's evidence kind is in its evidence check.
