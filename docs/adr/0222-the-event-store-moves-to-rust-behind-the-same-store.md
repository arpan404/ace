# 0222: The event store moves to Rust behind the same `Store`

Date: 2026-11-23. Status: proposed (draft for the owner). Decided by: pending the owner.

## Context

The daemon's event store (`apps/daemon/src/store.ts` and about forty modules it wires) is
TypeScript over node:sqlite. Its contract is written down in
[docs/store/behaviour.md](../store/behaviour.md). The owner has decided that the store is the
first of several parts of the daemon to move to Rust; the engine and provider adapters,
agent-control and machines follow, in that order.

### Measurements

Taken 2026-11-23 on an APFS clone of the owner's `events.sqlite` (46 GB, schema 35, 2,923
threads, 708,675 items, 14.5 M sequences), with `dbstat`, sampling scripts, and
`bun apps/daemon/bench/sqlite-store.ts --split` (Bun 1.4.4, M4 Max). No daemon ran on the clone.
The machine was shared and heavily loaded (load average 30 to 520), so absolute read times are
about twice an idle machine's; the shares below were the same in two runs.

**Where the 46 GB goes** (45.5 GB of pages; 5.7 GB of it is unused space inside pages):

| Part                                       | Size    | Share |
| ------------------------------------------ | ------- | ----- |
| `events` table                             | 11.2 GB | 24.5% |
| search tables and FTS indexes              | 8.9 GB  | 19.6% |
| `history_item_revisions` and friends       | 8.6 GB  | 18.8% |
| `items`, item heads, text chunks, previews | 5.6 GB  | 12.2% |
| `engine_state_records`                     | 4.1 GB  | 8.9%  |
| long-thread index (`long_*`)               | 3.6 GB  | 7.9%  |
| the three `events` indexes                 | 1.9 GB  | 4.1%  |
| output chunks and blobs                    | 1.1 GB  | 2.4%  |

- Event payloads by type: `item.updated` 2.4 M rows, 4.2 GB (each update stores the whole item);
  `item.created` 1.5 GB; `item.delta` 3.1 M rows, 1.2 GB; `thread.client.updated` 0.57 GB;
  `agent.status` 2.3 M rows, 0.44 GB.
- **An item's body is stored up to five times**: in the `events` row of each create and update
  (5.7 GB), as a history revision (3.1 M rows, 5.9 GB, of which 3.7 GB are revisions an item
  later replaced), as the current `items` row (2.6 GB), as the engine's `items` record
  (705 k rows, 2.5 GB) and as a preview (0.6 GB). Of 2,000 sampled history revisions, 1,393
  (70%) are byte-identical to the item in the event row at the same sequence.
- Growth: event payloads written in October 3.0 GB; 1 to 23 November 5.6 GB.
- Compression, sampled 1,000 rows per kind with a dictionary trained on 2,000 others: zstd
  level 3 alone gives 1.8× on event payloads; with a 110 KiB dictionary 4.0× overall,
  `item.updated` 5.1×, `agent.status` 3.6×, `item.delta` 2.8×; decoding takes 0.4 to 3 µs per
  row. One item's 30 revisions take 28 KB as rows and 1.9 KB as one zstd frame (15×).
- `PRAGMA auto_vacuum` is incremental (2); 231 free pages.

**Reads.** `--split` times each call inside node:sqlite (SQLite stepping plus building the row
objects), inside `JSON.parse`, and the rest (schema checks, shaping, copying, freezing):

| Read                  | p50 (loaded machine) | SQLite | JSON.parse | Rest   | Statements per call |
| --------------------- | -------------------- | ------ | ---------- | ------ | ------------------- |
| Sidebar page          | 172–309 ms           | 17–21% | 7–9%       | 71–74% | 942                 |
| List all threads      | 400–600 ms           | 23%    | 8%         | 68–69% | 1 (2,923 rows)      |
| Open a thread (first) | 26–66 ms             | 73–75% | 3%         | 22–24% | 218                 |
| Scroll back, 50 items | 12–13 ms             | 73–76% | 4–5%       | 20–22% | 112                 |
| Turns page            | 9–15 ms              | 93%    | 1–2%       | 5%     | 51                  |
| Items window          | 8–11 ms              | 60–62% | 5–6%       | 33–34% | 322                 |
| Catch-up              | 1.3–1.7 ms           | 93%    | 0%         | 7%     | 222                 |
| In-thread search      | 36–70 ms             | 98%    | 0%         | 2%     | 39                  |

The earlier finding that reads are bound by JSON decoding in JavaScript holds only for the
sidebar and the thread list. On this home every thread read spends three quarters or more inside
SQLite and row building, and issues tens to hundreds of statements per call. The JS heap grew
16 MiB across all reads (41 → 57 MiB after a full collection); peak resident memory of the bench
process was 1.35 GB against a 57 MiB heap, so most of the daemon's peak is outside the JS heap.

**Writes.** 1,021 commits of the bench's item writes: commit p50 2.9–3.1 ms, p95 11.6–15.2 ms,
max 146 ms, on the main thread. Each commit appended **66 pages (270 KB) to the WAL** for items
of a few hundred bytes; a streamed item cost 79 KB of database. Checkpointing that WAL (276 MB)
took 3.6 s on the checkpoint connection. With `wal_autocheckpoint=0` and the checkpoint worker
(`wal-maintenance.ts`), no checkpoint or fsync runs inside a `COMMIT` any more
(`synchronous=NORMAL` does not fsync on commit in WAL mode): the earlier profile that found
checkpoint fsyncs in commits predates that worker (2026-11-01). The cost left on the main thread
is the page writes themselves, set by how many copies and indexes each event touches. Open took
2.25 s.

### Constraints the design must meet

1. `Store` hands its connection to callers: `atomic`, `write` and `maintenance` run 614 call
   sites in 176 files with a node:sqlite `DatabaseSync`, inside the store's own transaction.
   Whatever runs the store must give those callers the same connection.
2. Two copies of the SQLite library must never open the same file in one process. SQLite's POSIX
   locks are per process: when one copy closes a descriptor on the file, the locks the other
   copy holds on it are released, and a writer or reader then runs unprotected
   ([How To Corrupt An SQLite Database File](https://sqlite.org/howtocorrupt.html), §2.2.1 and
   §2.2.2). Bun on macOS uses the system SQLite (`sqlite_source_id()` ends in `aapl`, 3.54.0);
   Node 26 embeds its own (3.54.1) and exports none of it. A Rust addon that bundles SQLite and
   opens `events.sqlite` beside node:sqlite would be exactly that hazard.
3. The `Store` API is synchronous, and reads inside an open write see that write's rows.
4. The owner's test rule: the existing TypeScript tests are the proof. They must run unchanged
   against the Rust implementation, chosen by a switch; no parity harness, no new tests.

## Decision

### 1. One Rust core, loaded in process, behind the same `Store`

- The Rust store is a **Rust crate first**, `ace-store`, with no Node types in it: a Rust engine
  later calls it directly, without crossing into JavaScript and back.
- The daemon loads it as **one N-API addon built with napi-rs** (`napi` 3, `napi-derive` 3),
  which Bun and Node both load. The binding crate, `ace-daemon-node`, is the only crate that
  depends on napi; it is thin, translating values and errors and nothing else.
- `Store` stays the TypeScript interface. The switch `ACE_STORE=native` (read once, in the
  connection factory at the I/O boundary) picks the implementation behind it; unset is today's.
- **The native store owns every connection to the event database in the daemon process.** With
  the switch on, the connection `Store` hands to `atomic` callers is the addon's, presenting the
  node:sqlite surface the daemon uses (`exec`, `prepare`, `isTransaction`, `location`, `close`;
  `run`, `get`, `all`, `iterate`; null-prototype rows, numbers, `Uint8Array` BLOBs, errors with
  node:sqlite's `errcode` and `errstr`). The checkpoint worker, the search query workers and the
  history publication worker open their connections through the same factory. That keeps one
  SQLite library per file (constraint 2), one transaction for TypeScript and Rust work
  (constraint 1), and synchronous semantics (constraint 3).
- Why not a sidecar process, as `ace-history` is: a second process cannot join the store's
  transaction, so every one of the 614 `atomic` callers would have to cross a process boundary,
  synchronously, for every statement, and reads inside an open write would have to fall back to
  TypeScript. The isolation a sidecar buys (a Rust crash or leak does not take the daemon down)
  matters less here than for history import, which parses untrusted provider files: the store
  reads only what ace wrote, node:sqlite is native code in process today, and panics are caught
  at the binding and become JS errors. A sidecar could keep the (a) tests runnable only by
  putting a synchronous channel (a worker blocked on `Atomics.wait`) between `Store` and the
  process; it would be slower than today on every statement.
- Why not a split (Rust reads in a sidecar, writes in process): the reads that matter run
  inside or right after writes (flush before read, savepoint snapshots for the sidebar,
  read-your-writes inside `atomic`), and the measured cost is inside SQLite, which a second
  process does not make cheaper.

### 2. Crates and workspace

- A new Cargo workspace, `native/daemon`, with the same toolchain, lints, `deny.toml` licence
  allowlist and checks as `native/history` (`rust-version 1.95`, `unsafe_code = "deny"` outside
  the binding, clippy `unwrap_used`/`expect_used` denied), run by `bun run check:daemon-native`.
  It is the daemon's Rust core: later crates join this workspace rather than starting their own
  (section "Path after the store").
- Crates now: `ace-store` (the store), `ace-daemon-node` (the addon, `cdylib`).
- Dependencies, chosen to avoid hand-written code where a crate does the job:
  - `libsqlite3-sys` 0.39 with `bundled`: the same SQLite `rusqlite` bundles, and the only
    SQLite touching the file once the switch is on. `ace-store` wraps it directly in one small
    module (`src/sqlite.rs`, the crate's only unsafe code, each block justified) instead of
    through `rusqlite`, because a statement must outlive one call: a JavaScript iterator steps
    it across calls and a JS object holds it, which `rusqlite`'s borrowed `Statement` and
    `Rows` cannot express, and lazy stepping is required (open-time passes iterate whole
    tables). Statements are owned by their connection and addressed by id, and closing a
    connection finalizes them, as node:sqlite's `close` does. `rusqlite` can still be used
    for Rust-internal reads on the same handle in phase 1b.
  - `napi` / `napi-derive` 3 for the binding (no `unsafe` in our code; napi-rs owns it).
  - `serde_json` with `raw_value` for building wire JSON without an intermediate tree (1b).
  - `zstd` 0.13 (libzstd 1.5.7, dictionary support) for the storage format in phase 4.
  - `crossbeam-channel` for the writer and checkpoint threads' queues (later phases).
- Alternatives rejected: `sqlx` (async-first, no shared synchronous transaction); `libsql` (a
  fork, a second dialect to reason about); `duckdb`/`redb`/`sled` (a format migration of 46 GB,
  which ADR 0170 rules out at open and nothing measured asks for).

### 3. Threading

- The **main connection** serves the synchronous `Store` API on the JS thread, as today: same
  ordering, same transactions, same errors.
- A **checkpoint thread** in the addon, with its own connection, replaces the checkpoint worker:
  `PASSIVE` while commits continue, `TRUNCATE` when quiet, the same rules as
  `wal-maintenance.ts`, without a JS worker or messages.
- A **reader pool** (two to four connections on Rust threads) serves reads that need no
  read-your-writes: socket reads outside any open transaction, as async variants added next to
  the synchronous ones (the server can await; the synchronous form stays and the tests use it).
  A read issued while the main connection has a transaction open always runs on the main
  connection.
- **One writer.** SQLite allows one writer per file. The writer phase (5) moves commits to a
  writer thread only when the writer's logic itself is in Rust; until then the main connection
  writes.

### 4. Group commit: not added

The live buffer already batches provider output (75 ms or 64 KiB, ADR 0076), and with the
checkpoint worker no commit fsyncs. A commit now costs its page writes: 66 pages for a small
item. Batching more events per commit would delay publication (events publish only after
commit, behaviour.md §4) for a saving that cutting the pages per event gives without that
trade. Phase 4 cuts the pages; group commit is reconsidered only if a measurement after it
shows commit count, not pages, dominating.

### 5. Reads return finished JSON

A native read assembles its whole answer in Rust from as few statements as it needs and returns
one JSON string (`serde_json::value::RawValue` keeps stored JSON as stored, no re-encoding). The
binding hands the string to `JSON.parse` in the shell, so the TypeScript method returns the same
objects it does today and the tests are unchanged. Where the wire encoder would serialise the
result again (events, snapshots), the shell seeds `EventEncodings` with the JSON it received, so
the server forwards those bytes without serialising them twice. A later step may add
bytes-returning methods for the socket path; the object-returning ones stay.

Trust (ADR 0125) is kept: Rust reads the same trust floor and rejected set, returns trusted rows
as stored, and returns untrusted rows marked for the shell's lenient Zod decode, which stays in
TypeScript until the writer phase.

### 6. Storage format: stop the growth, forward only

Each change applies to rows written after it ships; old rows stay readable as they are; nothing
history-sized runs at open (ADR 0170). Each is its own step with its own switch.

1. **One copy of an item body per revision.** A history revision identical to the item in the
   event row at its sequence (70% sampled) stores a reference to that row instead of the body.
   The other copies (engine `items` record, preview) are owned by the engine and the writer;
   which of them can go is an owner question below.
2. **Compressed payloads.** New payloads, item bodies and revisions are stored as zstd frames
   with a per-kind trained dictionary, in a BLOB column next to the JSON one, with a one-byte
   format tag. Dictionaries live in a table and are never changed once used; a new dictionary
   gets a new id. Measured gain 4× to 5× on new rows. Readers decode in Rust; a read of an old
   row reads its JSON as today.
3. **Cold storage** (optional, owner question): a thread settled for a long time moves, in idle
   bounded batches, to an append-only segment file of per-thread zstd frames (15× on revisions),
   with its index rows replaced by one pointer. This shrinks the hot B-trees and the indexes;
   it is the only one of the three that rewrites old data, so it never runs at open and never
   frees pages in the middle of hot tables (freeing scattered pages made later writes about 30%
   slower in October).

Compression trades CPU for size and I/O: 0.4 to 3 µs per row to decode. A thread open reads
about 600 rows (a millisecond); a full replay of a large thread (450 k events) about a second of
one core, off the main thread on the reader pool.

### 7. Phases, each shippable alone and switched off by `ACE_STORE`

| Phase | What moves to Rust                                                                                                                                                                                                                     | Switch                             | Proven by                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1a    | The connection: the addon owns the event database's connections (main, checkpoint, search query workers, history publication worker); all logic stays TS                                                                               | `ACE_STORE=native`                 | Every (a) test in behaviour.md §15 run with the switch on, plus the 257 test files that build a `Store`                              |
| 1b    | Thread reads that measured SQLite-bound: `readItemPage`/`readBoundedItemPage`, then `snapshotThread`'s transcript and `itemsWindow`, as single native calls returning JSON                                                             | `ACE_STORE_READS=items` (needs 1a) | `item-store-trusted-reads`, `subscription-*`, `stored-history-trust`, `text-storage`, `payloads`, `agent-control/thread-read-paging` |
| 2     | Long-thread reads: `turnsPage`, `turnSteps`, `threadCatchUp`, `threadSearch`                                                                                                                                                           | `ACE_STORE_READS=long`             | `long-thread-*`, `search-replay-*`                                                                                                   |
| 3     | The sidebar and thread list: one native call per page from the sidebar index, without decoding whole thread rows in JS                                                                                                                 | `ACE_STORE_READS=sidebar`          | `sidebar-*`, `thread-cache.process`, `thread-columns.process`, `revision-triggers.process`                                           |
| 4     | Storage format (section 6, steps 1 and 2), writes still from TS through the native connection                                                                                                                                          | `ACE_STORE_FORMAT=2`               | All (a) tests, with format 2 on and off; a home written with it on must open with it off                                             |
| 5     | The writer: `EventWriter`, the live buffer and sequence reservation in Rust, on a writer thread, with the event folding (`@ace/projection` `updateThread`) ported and pinned by vectors generated from the TypeScript, as ADR 0207 did | separate switch, decided then      | All (a) tests; `canonical-event` samples become vectors                                                                              |

Each phase is off by default until its tests pass on macOS, Linux and Windows and a
before-and-after run of `sqlite-store.ts --split` on a clone shows it is no slower. A phase that
fails in the field is turned off by its switch with no data change (phases 1 to 3 change no
stored bytes; phase 4's rows stay readable by a build with it off because the read side ships in
the same release before the write side is turned on).

### 8. Building and shipping

The addon is built per platform with `cargo build --release -p ace-daemon-node` and shipped
beside the daemon the way `tools/release/src/ace-history.ts` ships `ace-history`. A development
tree builds it from `scripts/` on demand. With `ACE_STORE=native` and no addon, the store refuses
to open and says so; it never falls back silently, so a test run with the switch on proves the
native path.

## Consequences

- A Rust crash in the store crashes the daemon, as a node:sqlite crash does today. Panics are
  caught at the binding (`napi` `catch_unwind`) and thrown as JS errors.
- Phase 1a alone changes no behaviour and gains little speed: its value is that the native
  connection exists, so phases 1b to 3 can run Rust reads in process without the two-copies
  hazard, and the Rust engine later shares the store's transactions.
- Every statement TypeScript issues crosses N-API with the switch on. That cost is measured
  before 1a ships; if it makes the write path slower, phase 1a ships together with the phase that
  moves those statements' callers.
- Correctness ahead of speed, where they trade: reads keep running on the main connection
  whenever a transaction is open, even though the pool would be faster; group commit is not
  added; format changes are forward-only and never rewrite old rows at open.
- `native/daemon` is a new workspace to build in development and release: one more `cargo build`
  in `bun install`'s setup and in each release platform.

## Path after the store

The same workspace, the same addon, the TypeScript shell shrinking one boundary at a time.

1. **Engine and provider adapters** (`ace-engine`, `ace-adapters`): the engine calls `ace-store`
   in Rust (append, live buffer, snapshots in the same transaction). The boundary to TypeScript
   becomes the engine's command and event interface (`engine/index.ts`): the server sends
   commands in and receives published events out. Adapters spawn the provider CLIs from Rust;
   their recorded fixtures stay the tests.
2. **Agent-control** (`ace-agent-control`): delegation, waits and the MCP tools move next to the
   engine; the boundary is the MCP tool surface the server exposes.
3. **Machines** (`ace-machines`): pairing, remote children and relay links; the boundary is the
   machine link protocol.

At each step the crate depends on `ace-store` and the crates before it directly, the binding
crate gains one module, and the TypeScript tests of that part keep running through its
TypeScript interface.

## Questions for the owner

1. Is the in-process addon acceptable, given that it puts the event store's native code in the
   daemon process (as node:sqlite already is), rather than the process isolation `ace-history`
   has?
2. Phase 1a routes every statement the TypeScript writer issues through the native connection
   when the switch is on. The writer's logic does not change, but its statements run on the
   addon's SQLite. Is that inside "do not change the writer yet", or should 1a wait for phase 5?
3. Item bodies are stored up to five times (events, history revision, `items`, engine `items`
   record, preview). Which copies may the writer stop making? The history reference (70% of
   revisions) is safe by construction; the engine record and the preview are the engine's.
4. Search takes 8.9 GB (19.6%), of which the trigram indexes are about 3 GB. Keep trigram search
   over every body, or index bodies only up to a size?
5. Cold storage for long-settled threads: wanted, and after how long?
6. Compression is forward-only: old rows stay as they are, so the file stops growing as fast but
   does not shrink. Should an idle, bounded recompression of old rows run (it rewrites history,
   in batches, and leaves free pages that space reclaim returns)?
7. `idle-store.perf.process.test.ts` tests the bench's seeding script, not the store
   (behaviour.md §15, class c). Delete it or move it to the bench check?
