# Porting the store's reads to Rust: phases 1b, 2 and 3

For the builders who move the event store's reads to Rust, in parallel, one phase each. Read
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
after; and anything in the contract you could not keep. Do not change the writer, the storage
format or any stored data; those are later phases and need the owner.
