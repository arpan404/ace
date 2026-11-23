# The event store: observable behaviour and invariants

This is the contract any implementation of the daemon's event store must keep, whichever
language runs it. It describes `Store` (`apps/daemon/src/store.ts`) and the modules it wires, as
of `origin/main` 301a08eeb8 (2026-11-23). Each rule cites the code that holds it today. Where a
rule is enforced by a test, the test is named in the last section, which also says which tests
must pass unchanged on a second implementation.

"Committed" means a SQLite `COMMIT` on the store's connection returned. "Published" means the
store handed events to its `subscribe` listeners. "Thread" means a `threads` row.

## 1. The connection

- One SQLite connection per `Store`, opened on `path` or supplied as `options.database`, which
  the store then owns and closes (`store.ts:97`, `store.ts:198`).
- Pragmas set at open, in this order (`store.ts:274`): `busy_timeout=5000` first (on an existing
  file `auto_vacuum` writes the header and must wait like any writer), `auto_vacuum=INCREMENTAL`,
  `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `cache_size=-2048` (2 MiB),
  `mmap_size=0`, `temp_store=FILE` during migrations then `MEMORY` once open (`store.ts:425`),
  `wal_autocheckpoint=0`, `journal_size_limit=16777216`.
- The connection is handed to callers as node:sqlite's `DatabaseSync` through `atomic`, `write`
  and `maintenance` (`store.ts:733`, `store.ts:814`, `store.ts:829`), and as prepared statements
  through `statement(sql)` (`store.ts:499`). 176 daemon files make 614 such calls. What they use
  of the API: `exec`, `prepare`, `isTransaction`, `location()` (`migrations.ts:310`), `close`, and
  on statements `run` (`changes`, `lastInsertRowid`), `get`, `all`, `iterate`. Rows come back as
  null-prototype objects; integers as JS numbers; BLOBs as `Uint8Array`. Any second
  implementation must keep this surface on the same connection and transaction, because these
  callers' SQL commits or rolls back with the store's own rows.
- Prepared statements are cached per connection in a bounded LRU keyed by SQL text, never by
  entity ids: 256 entries (`store.ts:143`, `store.ts:499`).
- Other connections to the same file exist and must stay correct beside the store's: the WAL
  checkpoint worker (`wal-checkpoint-worker.ts:9`), search query workers
  (`SearchQueries`, `store.ts:367`), the history publication worker (opens with
  `storedTrustReader`, `store-trust.ts:20`), and short read-only probes. Other connections'
  commits are detected through `PRAGMA data_version` (`store.ts:204`).

## 2. Opening

Open runs in this order and either finishes or closes the connection and throws
(`store.ts:270`–`store.ts:428`):

1. Pragmas (above); the WAL maintenance shell is built, with a worker only if the journal mode
   really is WAL (`store.ts:278`).
2. `migrate(db)` (`migrations.ts:221`). The daemon migrates forward from schema 14
   (`UPGRADE_FLOOR`, `migrations.ts:207`) to `schemaVersion = migrations.length`
   (`migrations.ts:209`; 35 on the measured home). Older layouts are refused, never repaired
   (`migrations.ts:237`, `migrations.ts:249`). The steps run in one transaction, so a failed step
   rolls back whole; the full-copy backups older builds left beside the file are deleted
   (`migrations.ts:309`).
3. `StreamSequences.initialize` reads `host_sequence` (`stream-sequences.ts:19`).
4. Sidebar revision triggers are migrated (`sidebar-revisions.ts:26`), then the lineage mark is
   checked (section 3).
5. Open-time passes, each in its own transaction through `atomic`: thread row trust, projects,
   thread client/cold columns, sidebar columns and triggers, permission modes, engine record
   indexes, two `CREATE INDEX IF NOT EXISTS` on `threads`, payload tables, native images, tool
   results, measurements, thread row indexes, history index, status store, run client, entity
   trust, long-thread index, seeded thread client fields, sent messages, recent thread row
   confirmation (`store.ts:284`–`store.ts:337`). ADR 0170 bounds all of them: none may do work
   that grows with stored history. A pass that needs history-sized work runs later in idle,
   bounded batches (search backfill, long-thread backfill, the trust pass).
6. Stored-row trust opens (`openStoreTrust`, `store-trust.ts:37`), after every pass that rewrites
   rows and before the first append.
7. `publishedSeq` is set to the head: existing history is covered by new subscribers' snapshots,
   never republished (`store.ts:431`).
8. Background work starts and never blocks open: search backfill, long-thread backfill, the idle
   trust pass (`store.ts:432`–`store.ts:458`).

Measured on a clone of the owner's 46 GB home (ADR 0222, Measurements): open took 2.25 s.

## 3. Sequences and ordering

- Every event has a host-wide `seq`, strictly increasing in commit order, with no reuse.
  `events.seq` is the `INTEGER PRIMARY KEY`; `events.id` is unique.
- `head()` is the larger of `MAX(events.seq)` and `MAX(usage_deletions.seq)`
  (`stream-sequences.ts:29`). While a live batch is buffered or mid-flush the visible head is the
  buffer's (`store-stream.ts:125`).
- Sequences are reserved durably before any goes out: `prepare` commits
  `host_sequence.seq = after + max(65536, n)` in its own transaction (`stream-sequences.ts:51`),
  then tells the lineage mark (`store.ts:229`). `next(after)` hands out `max(cursor, after) + 1`
  and throws `Sequence exhausted` past `Number.MAX_SAFE_INTEGER` (`stream-sequences.ts:46`).
- Deletion takes a sequence too: `usage_deletions(seq, thread_id, at)` is a durable tombstone
  (`store.ts:1461`). Replay that meets a gap left by deleted events crosses it only when a
  tombstone at or after the gap exists, otherwise it throws `Missing committed history events`
  (`store.ts:914`).
- Lineage (ADR 0128): beside the database the daemon keeps a mark `{token, reserved}` written
  through a temp file and rename (`sequence-lineage.ts:36`). At open, a database whose own token
  matches the mark but whose reserved sequence is below it was rolled back (restored or copied):
  it takes a new `sidebar_epoch` token so every client reads it afresh (`store.ts:1117`,
  `sequence-lineage.ts:27`). The mark is rewritten every 64 published sequences before clients
  hear them (`store.ts:17`, `store.ts:757`) and on every reservation. A failed mark write is
  reported, never fatal (`store.ts:1128`).
- `replaySafe(after)` is false for a cursor past both head and reservation, or one that names a
  sequence not stored (inside a compacted delta span); such a client needs a fresh snapshot
  (`stream-sequences.ts:37`, `store-stream.ts:76`).

## 4. Transactions

`transaction(run, outcome?)` (`store.ts:567`) is the only way the store writes; `atomic(run)`
exposes it with the connection (`store.ts:733`).

- Before any transaction, buffered live writes are flushed (`store.ts:568`), so the transaction's
  own rows order after them.
- Top level: `BEGIN IMMEDIATE` (`store.ts:607`). Nested: a numbered `SAVEPOINT`
  (`store.ts:576`). `run` must be synchronous; a returned promise throws
  `Store transactions must be synchronous` (`store.ts:614`).
- A nested failure rolls back to its savepoint, discards uncommitted thread-cache entries and
  read caches, bumps `rollbackGeneration`, settles its own live outcomes as rolled back, and
  rethrows. If the savepoint cannot be undone (SQLite already rolled back for `SQLITE_FULL` or an
  I/O error, or the recovery failed) the whole transaction is doomed: the outer one rolls back
  instead of committing (`store.ts:588`–`store.ts:601`, `store.ts:665`).
- Commit success: thread cache commits, `transactions++`, read caches drop the written threads'
  entries, the WAL maintenance shell wakes, then events publish (`store.ts:620`–`store.ts:628`).
- Commit failure or any throw: roll back if SQLite has not already, bump `rollbackGeneration`,
  invalidate sidebar caches, settle every pending live outcome as rolled back, rethrow
  (`store.ts:629`–`store.ts:636`). A failed rollback is reported; the caller's own error is the
  one thrown (`store.ts:682`).
- Publication happens only after `COMMIT` returns, in sequence order, interleaving the live
  buffer's settlements in the order they were nested (`store.ts:641`–`store.ts:650`). Events at
  or below `publishedSeq` are never published again (`store.ts:706`).
- Usage listeners hear every commit; at most 16 may subscribe (`store.ts:520`, `store.ts:647`).
- `onWrite` hooks run inside the transaction of every event batch; what they write commits or
  rolls back with the events (`store.ts:511`, `store.ts:1191`).
- Rows the event writer changes are attributed to the threads of its events
  (`attributedChanges`, `store.ts:1188`); anything else that changed rows on the connection
  (hooks, direct SQL) is unattributed and drops every cached read (section 7).
- `rollbackGeneration()` changes after any rollback, including event-free ones; in-memory
  projections reload when it changes (`store.ts:559`).
- `installHistory` runs its own `BEGIN IMMEDIATE`; while it runs a live write is refused with
  `Store is busy` and other `transaction` calls run inline (`store.ts:569`, `store.ts:888`).

## 5. Appending events

`appendEvents(threadId, payloads, at)` (`store.ts:1176`) runs `EventWriter.append` inside one
transaction with the write hooks. Per payload (`event-writer.ts:88`):

1. The thread is checked out once: the shared frozen row and a lazy private copy
   (`event-writer.ts:108`). `item.delta` reads the frozen thread only: it changes no column.
2. Run client preparation and decoration (tool results, native images, measurements) may
   rewrite the payload (`event-writer.ts:114`, `event-writer.ts:202`).
3. A new sequence and a time-ordered id; the payload is made canonical exactly as
   `Event.parse` would (`canonicalEvent`, `canonical-event.ts:17`), or kept as given when it
   already is (`appendParsed`, `event-writer.ts:82`).
4. `thread.created` inserts the thread (refused for an unregistered workspace or a duplicate) and
   marks the workspace recently used unless imported (`event-writer.ts:131`–`event-writer.ts:163`);
   any other event on an unknown thread throws `Unknown thread`.
5. A live metadata change may queue a follow-up event in the same append
   (`event-writer.ts:167`).
6. Non-delta events fold into the thread with `updateThread` (`@ace/projection`) and write only
   the changed columns, hot and cold, then remember the rebuilt thread at its new revision
   (`event-writer.ts:170`, `event-writer.ts:214`).
7. Raw payloads over the cap are moved to blobs and the payload capped (`payload-store.ts:188`);
   then, in this order: payload tables (`payload-store.ts:213`), history revisions
   (`history-index.ts:227`), status entities (`status-store.ts:165`), long-thread index, the
   `events` row, `host_sequence`, MCP data (`event-writer.ts:174`–`event-writer.ts:183`).
8. After the batch: search learns thread metadata changes or deletion, and every event is
   covered for search (`event-writer.ts:186`–`event-writer.ts:199`).

All of it is one transaction: an append is atomic with every derived row, hook row and receipt
written in the same `atomic`.

## 6. Live writes (the streaming path)

Provider deltas take the buffered path so a running agent does not commit per token
(ADR 0076): `prepareLiveWrite`, `bufferLiveWrite`, `flushLiveWrites` (`store.ts:535`–`store.ts:548`).

- Admission (`store-stream.ts:82`): refused with `Store is busy` while writes are held or history
  publishes, or a batch is sealed inside an open transaction; refused with `LiveWriteRetry` while
  a failed batch waits for its retry. An over-full buffer drains first. One batch over 8 MiB of
  weight never fits (`live-write-buffer.ts:84`).
- Append (`store-stream.ts:96`): events get sequences and canonical envelopes at once and are
  pinned with the engine's snapshot. A batch of deltas only is published to subscribers
  immediately, before it is stored (`store-stream.ts:117`, `store-stream.ts:253`). Any non-delta
  event, or 64 KiB of weight, flushes now (`live-write-buffer.ts:109`). Otherwise a timer flushes
  within 75 ms, or 1 s for a batch of liveness snapshots only (`live-write-buffer.ts:22`).
- Every read that may see stored rows flushes first (`store.ts:1235`, `thread-reads.ts`
  `flush`, `bounded-events.ts:37`): reads always include buffered output.
- Flush (`store-stream.ts:204`): one transaction for the whole batch. The published prefix is
  stored compacted (adjacent deltas of one item, agent and field merge into rows of at most
  4 KiB that keep the span's final sequence, `live-write-buffer.ts:204`); the held suffix nobody
  has seen is stored uncompacted; after a live-metadata follow-up every later held event is
  renumbered so the stored order matches an unbuffered append. Snapshots persist in the same
  transaction. Only rows subscribers have not seen are published after commit.
- A flush nested in an open transaction seals the batch until that transaction settles: commit
  releases it, rollback re-arms it to be written again exactly once (`store-stream.ts:251`).
- A failed flush keeps the batch pinned and retries on a backoff of 100 ms doubling to 5 s
  (`live-write-retry.ts:10`). Contention and a full disk never count toward quarantine; after six
  other failures each thread's share is written alone, and a thread whose share still fails is
  dropped and its session stopped with "Recent output could not be saved…", told through
  `onLiveWriteQuarantine` (`store-stream.ts:168`, `store-stream.ts:187`, `store.ts:710`).
- A retry treats rows an earlier attempt already committed (same seq and id) as stored
  (`store-stream.ts:211`).
- `writable()` waits while a failed batch is pinned (`store.ts:781`).

## 7. Caches, held views and their invalidation

Every cache below must give the same answers as an uncached read; none may show rows that a
rollback undid.

- Thread cache (`thread-cache.ts:48`): decoded threads keyed by row revision, which
  `sidebar_thread_revisions` triggers bump on every insert or update, including direct SQL.
  Committed entries are kept for good (a committed revision is never handed out again); entries
  read inside the store's own write are kept apart and dropped on savepoint rollback, promoted on
  commit (`thread-cache.ts:62`–`thread-cache.ts:77`). Budget 256 threads and 16 MiB
  (`thread-cache.ts:53`). `readThread` returns a shared deeply frozen value, `getThread` a private
  copy (`store.ts:1062`).
- Thread read cache (`thread-read-cache.ts:20`): committed reads per thread, keyed by a version of
  everything unattributed (`data_version` plus unattributed `total_changes`, `store.ts:203`).
  Inside any open transaction it neither serves nor stores (`thread-read-cache.ts:79`). A commit
  evicts the threads it wrote before any later read (`store.ts:622`); a version change drops
  everything and invalidates held views (`thread-read-cache.ts:84`).
- Held views (`thread-reads.ts:106`): `acquireThread` leases a view kept current by published
  batches (`updateViews`, `thread-reads.ts:71`); `releaseThread` ends the lease. Held views
  follow committed data only: inside an open transaction the caller gets a private view, and a
  batch published inside a transaction only marks views stale. `viewedThreads()` lists held
  threads.
- Snapshots (`snapshotThread`, `thread-reads.ts:142`): contents frozen and shared until the
  thread changes; the top level always carries the current head. The default tail is 200 items
  and 1 MiB (`thread-reads.ts:28`); a smaller tail bounds only the transcript and says it is
  partial.
- Sidebar caches (`sidebar-reads.ts:58`): page and summary caches keyed by
  `total_changes:data_version`; every read runs inside a store-owned read savepoint
  (`store.ts:1146`) so membership and rows come from one snapshot; a live window reads the
  sidebar index only outside a write. Any rollback clears them (`store.ts:633`).
- Event encodings (`event-encodings.ts:25`): each published event is serialised once and shared
  by the live buffer and the wire encoder; trimmed forms (short deltas, raw-on-demand) once each.
  Keys are weak; an encoding is valid only while the event holds the payload it was made from.

## 8. Reads

All reads flush buffered live writes first. Unless noted they are synchronous and return plain
values. Page sizes and byte budgets are part of the contract: clients page by them.

| Read                                                                                                                                                            | Inputs → output                                                         | Notes                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `readEvents` (`store.ts:1229`)                                                                                                                                  | `afterSeq`, `threadId?`, `limit`, `byteLimit?` → `Event[]` in seq order | The event that crosses `byteLimit` is included, so callers tell overflow from completion.                  |
| `countThreadEvents` (`store.ts:1257`)                                                                                                                           | thread, (after, through], limit → count                                 | Index only, no payload read.                                                                               |
| `bounded.threadEvents` (`bounded-events.ts:31`)                                                                                                                 | thread, range, `{rows, bytes}` → events or `undefined`                  | Sizes from record headers first; nothing decoded unless the range fits (ADR 0155).                         |
| `readSearchPage`, `readUsagePage` (`store.ts:1271`)                                                                                                             | after, limit, bytes → page with coverage                                | Skip transcript/output bodies; advance coverage across deletions.                                          |
| `getThread` / `readThread` / `readThreads` (`store.ts:1062`)                                                                                                    | ids → `Thread` copy / frozen / map                                      | Missing threads have no entry.                                                                             |
| `listThreads` (`store.ts:1169`)                                                                                                                                 | → every thread, `updated_at DESC, id`                                   |                                                                                                            |
| `sidebarPage` (`store.ts:1105`)                                                                                                                                 | limit, project, archived, cursor, reuse → entries and window            | Pinned and unsettled first, then 20 settled per page; one snapshot.                                        |
| `hasLiveThread`, `waitingBlockers`, `updateBlockers` (`store.ts:1083`)                                                                                          | → boolean / counts                                                      | Partial indexes on `threads`; no history decode.                                                           |
| `acquireThread`, `snapshotThread` (`store.ts:1310`)                                                                                                             | thread, tail → `ThreadView`                                             | Status, agents, interactions and queue whole; transcript bounded.                                          |
| `readItems`, `readItemPage`, `readBoundedItemPage` (`store.ts:1344`, `store.ts:1391`)                                                                           | thread, before, limit, byteLimit (1 MiB) → items, `itemsBefore`         | Bounded variant never fails on one oversized item; it summarizes or drops raw.                             |
| `readHistorical*`, `historicalItemCount/Completion/Opening` (`store.ts:1404`–`store.ts:1444`)                                                                   | thread, `through` seq, …                                                | The thread as it was at `through`, from `history_item_revisions`.                                          |
| `readEntityPage` (`store.ts:1317`)                                                                                                                              | thread, collection, cursor → page                                       | At most 200 entries whatever the limit.                                                                    |
| `readInteractionRequest`, `interactionRequestVersion`, `getInteraction`                                                                                         | thread, id, offset → page / version                                     | Pages never end inside a UTF-16 pair (`interaction-reads.ts`).                                             |
| `itemCreatedSeq`, `itemRawRevision`, `itemRawEntries` (`store.ts:1330`)                                                                                         | thread, item → seq / revision / raw entries                             |                                                                                                            |
| `readOutput*`, `outputInfo`, `outputThread`, `blobInfo`, `readRawChunk`, `readHistoryBlob` (`store.ts:1388`–`store.ts:1459`)                                    | stream or blob, offset, limit → bytes                                   | Exact byte ranges; the server caps a read at 256 KiB.                                                      |
| `turnsPage`, `turnSteps`, `stepSurface`, `itemsWindow`, `threadSearch`, `threadCatchUp`, `threadReadState` (`store.ts:1347`–`store.ts:1380`)                    | the protocol requests → pages                                           | Long-thread index (`long-thread/queries.ts`); `authorize` filters descendants before anything is revealed. |
| `search.*`, `searchQueries.query`                                                                                                                               | text → hits                                                             | Index in this connection; queries in workers on their own connections.                                     |
| `commandReceipt`, `commandOwner` (`store.ts:1287`)                                                                                                              | command, device → result / owner                                        | One device under two ids counts as one (ADR 0115).                                                         |
| `getWorkspace`, `getWorkspacePath`, `executionWorkspace`, `importedSource`, `nativeSessionKeys`, `getMcpAgent`, `listMcpAgents`, `readMcpIntents`               |                                                                         | Plain row reads.                                                                                           |
| `headSeq`, `replaySafe`, `sidebarToken`, `sidebarRowRevision`, `rollbackGeneration`, `streamingMetrics`, `liveWriteBlocked`, `hasLiveWrite`, `isHistoryWriting` |                                                                         | State reads.                                                                                               |

Reads inside an open write see that write's rows (one connection). Reads outside see committed
data only.

## 9. Writes other than appends

`createWorkspace`, `recordWorkspaceFileChange` (fans out in pages of 64 threads, one transaction
per page, never scanning history: `store.ts:1031`), `completeWorkspacePreparation`,
`enqueueMcpIntent` (refused for an unknown caller; intent and events in one transaction),
`acknowledgeMcpIntent`, `capRaw`, `appendRawChunk`, `markThreadRead` (listeners told possibly
before commit, `store.ts:1385`), `recordCommand` and the receipt family (`command-receipts.ts:19`:
a command id runs once per device; its result is stored with the effects in one transaction),
`deleteThread` (tombstone, events and thread row in one transaction, `store.ts:1481`),
`purgeThreadData` (tombstone, then transcript rows in bounded batches, `store.ts:1474`,
`storage/transcript.ts`).

## 10. Admission: write gate, maintenance and history publication

- `write(run, signal)` (`store.ts:814`) waits for `writable()`, then rechecks in the same turn
  as the commit and runs `atomic(run)`. Writers wait for maintenance by default; there is no
  hold bound unless `writeGate.holdMs` is set (`store-write-gate.ts:10`), because a write after an
  external effect cannot be retried safely.
- `writer()` registers a writer whose commits span awaits (`store-write-gate.ts:48`); it throws
  `Store is busy` while maintenance holds writes.
- `maintenance(work)` flushes live writes, holds new writers, drains registered ones within
  10 s (`store-write-gate.ts:28`) or fails busy, then runs `work(db)`; it refuses while a
  transaction or history installation is open, and after `close` (`store.ts:829`).
- History publication: `startHistoryWriting` waits for the gate and registers the publication
  worker as a writer (`store.ts:838`). While it runs, live writes are refused, the search writer
  and WAL truncation pause, and publication of this connection's events is deferred; ending it
  publishes everything from the fence in pages of 64, including events listeners create while it
  does so, and wakes waiters (`store.ts:845`–`store.ts:886`). `notifyHistory` publishes another
  connection's commits in pages of 16, yielding between pages, then truncates the WAL
  (`store.ts:921`).
- Error classes callers branch on (`store-busy.ts`): `isStoreBusy` (SQLite 5/6 or
  `Store is busy`), `LiveWriteRetry`, `isStoreRetry` (either, or a full disk, ADR 0176).

## 11. Durability, WAL and crash recovery

- WAL with `synchronous=NORMAL`: a `COMMIT` appends frames to the WAL without fsync; durability
  against power loss comes at checkpoints. A process crash loses nothing committed
  (`wal-maintenance.process.test.ts` "rows committed before a crash survive it").
- Checkpoints never run inside a commit (`wal_autocheckpoint=0`). A worker connection runs
  `PASSIVE` once a second while commits continue and `TRUNCATE` after five quiet seconds, never
  while a transaction, history publication or buffered output is open (`wal-maintenance.ts:7`,
  `wal-maintenance.ts:61`). If the worker fails, checkpoints run on the store's connection with
  `busy_timeout=0` so the WAL stays bounded (`wal-maintenance.ts:133`, `store.ts:462`). Closing
  leaves an empty WAL.
- Partial streams: buffered output not yet flushed at a crash is lost, but no client saw it as
  stored; clients that saw published-but-unstored deltas resume from a cursor `replaySafe`
  rejects and get a snapshot (section 3). The engine's own snapshots commit in the same
  transaction as the rows they describe, so recovery never applies a fact twice.
- Interrupted maintenance (compaction, purge, retention) resumes from the storage journal
  (`storage/journal.ts`; `storage/recovery.process.test.ts`).

## 12. Shutdown

`close()` (`store.ts:472`, `store-shutdown.ts`) is idempotent and, in order: drains the live
buffer (one last attempt even while a retry is scheduled, `store-stream.ts:140`), stops the
buffer timer, WAL maintenance, search, the search writer and the trust pass, joins the search
query and checkpoint workers, clears statements, listeners and held views, and closes the
connection. Every step runs even if an earlier one failed; one failure is rethrown, several as an
`AggregateError`.

## 13. Trust at the storage boundary (ADR 0125)

- Rows this build wrote are read without validating again; others are decoded leniently, unknown
  variants kept as `unknown` with their raw data (`stored-decode.ts:24`, `stored-decode.ts:113`).
- Trust is a sequence floor plus a set of rejected sequences (`stored-decode.ts:45`), set at
  open from the stored shape fingerprint and build id (`stored-shape.ts:172`) and widened by an
  idle pass that confirms older rows in bounded batches when nothing is busy
  (`stored-trust-pass.ts:78`). Rows the pass finds would decode differently stay on the
  validating path across restarts.
- Thread rows and entity rows have their own trust (`thread-row-trust.ts`, `entity-shape.ts`).
- A trusted event's wire size is computed from the stored JSON without re-serialising
  (`stored-decode.ts:129`); replay pages break at the same event whether rows are trusted or
  decoded.

## 14. Size, retention and reclaim

- Raw provider payloads over the cap move to content-addressed blobs per thread
  (`payload-store.ts:151`); output streams are chunked (`output_chunks`); long item text is
  append-only chunks (`item-text-store.ts:112`), so a delta never rewrites an item body.
- Retention (`storage/data-retention.ts`) removes idle threads past the window in bounded passes;
  pinned, waiting and working trees are protected (`storage/retention.process.test.ts`).
- Space reclaim (`storage/space-reclaim.ts`) returns free pages with `incremental_vacuum` in
  bounded chunks once 64 MiB or a tenth of the file is free; it never deletes rows and never runs
  `VACUUM`, which would renumber rowid tables without an `INTEGER PRIMARY KEY`
  (`storage/apply.ts:136`).

## 15. The tests that guard this, and which carry over

The plan (ADR 0222) keeps `Store` as the TypeScript interface and changes what sits behind it.
So the tests that drive `Store` are the proof for each phase: they run unchanged with the
implementation switch set to native. The 257 other test files that build a real `Store` as a
fixture (engine, server, forge, workspace tests) carry over the same way and are not listed.

- **(a)** behaviour through the store's public surface: must pass on the native implementation
  unchanged.
- **(b)** tests of TypeScript internals that would not transfer as they are: the behaviour each
  guards and where that behaviour is checked against the native implementation instead.
- **(c)** redundant or structural: could be deleted.

| Test file                                                                                                                                                                                                                                       | Class | What it guards                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store.test.ts`                                                                                                                                                                                                                                 | a     | Gap-free sequences across appends, transactional snapshots, held views across rollback, live ownership checks.                                                                                                                                                                          |
| `store-auto-rollback.test.ts`                                                                                                                                                                                                                   | a     | Rows lost to SQLite's own rollback are never reported committed; a doomed savepoint rolls the whole transaction back.                                                                                                                                                                   |
| `store-held-view-rollback.test.ts`                                                                                                                                                                                                              | a     | Held views never show rolled-back rows, for every way a transaction ends.                                                                                                                                                                                                               |
| `store-live-write-recovery.test.ts`                                                                                                                                                                                                             | a     | Bursts in a transaction commit once; rolled-back bursts are written again once; retries back off; already-stored rows count.                                                                                                                                                            |
| `store-live-writes.test.ts`                                                                                                                                                                                                                     | a     | Renumbering after a follow-up; deltas reach subscribers once and match stored text.                                                                                                                                                                                                     |
| `store-read-cache.test.ts`                                                                                                                                                                                                                      | a     | Read-your-writes per thread; other connections' and unattributed writes drop cached reads.                                                                                                                                                                                              |
| `stored-history-trust.test.ts`                                                                                                                                                                                                                  | a     | Old history revisions decode with new defaults; pages break the same trusted or not.                                                                                                                                                                                                    |
| `stored-shape.test.ts`                                                                                                                                                                                                                          | a     | Events read back exactly; rows from another build are decoded again. Uses the `eventShape` option, part of the `Store` options.                                                                                                                                                         |
| `stored-trust-pass.test.ts`                                                                                                                                                                                                                     | a     | The idle pass changes no read, resumes after restart, stays idle while writes run.                                                                                                                                                                                                      |
| `stored-trust-rows.test.ts`                                                                                                                                                                                                                     | a     | Older homes open without indexing history; rows are checked by the next build.                                                                                                                                                                                                          |
| `stored-trust-coverage.test.ts`                                                                                                                                                                                                                 | a     | Every trusted table has a row planted and stays on the validating path when it would decode differently.                                                                                                                                                                                |
| `stored-trust-batch.test.ts`                                                                                                                                                                                                                    | b     | The pass's batch loads no more JSON than its budget. Guards memory of the TS pass; a native pass is held to `storage/retention-loop` style bounds and to `stored-trust-pass` reads.                                                                                                     |
| `thread-row-trust.test.ts`                                                                                                                                                                                                                      | a     | Thread rows read back exactly across restarts; unconfirmed rows validated on read.                                                                                                                                                                                                      |
| `thread-cache.process.test.ts`                                                                                                                                                                                                                  | a     | Reads after event writes, direct SQL, other connections, rollbacks and reused revisions.                                                                                                                                                                                                |
| `thread-cache.test.ts`                                                                                                                                                                                                                          | b     | `ThreadCache`'s byte budget and copy isolation. Copy isolation is also checked through `getThread` in `store.test.ts`; the budget is a TS heap concern.                                                                                                                                 |
| `thread-cold.test.ts`                                                                                                                                                                                                                           | a     | The thread_cold move runs once, on the first open of an older home.                                                                                                                                                                                                                     |
| `thread-columns.process.test.ts`                                                                                                                                                                                                                | a     | A random event stream reads the same from cache, after restart and after upgrade.                                                                                                                                                                                                       |
| `revision-triggers.process.test.ts`                                                                                                                                                                                                             | a     | Revision triggers under `INSERT OR IGNORE`, cold-row moves and deletes.                                                                                                                                                                                                                 |
| `sequence-lineage.test.ts`                                                                                                                                                                                                                      | a     | A rolled-back database is renamed; one reopened as it was is not.                                                                                                                                                                                                                       |
| `canonical-event.test.ts`, `canonical-event-schemas.test.ts`                                                                                                                                                                                    | b     | `canonicalEvent` equals `Event.parse`. Stays TS while the writer folds in TS; when the writer moves, the same samples become vectors the Rust canonicaliser must match (as ADR 0207 did for history).                                                                                   |
| `item-store-trusted-reads.test.ts`                                                                                                                                                                                                              | a     | Trusted and validated item reads agree; streaming text has every chunk; page budgets.                                                                                                                                                                                                   |
| `write-path-reads.test.ts`                                                                                                                                                                                                                      | a     | Output into older shell items is stored back in this build's shape; message revisions kept.                                                                                                                                                                                             |
| `text-storage.process.test.ts`                                                                                                                                                                                                                  | a     | Text chunks after non-text parts, authoritative replacement, surrogate pairs across chunks.                                                                                                                                                                                             |
| `payloads.process.test.ts`                                                                                                                                                                                                                      | a     | Exact output byte ranges, read caps, raw caps with hashed blobs, rollback of chunks and blobs.                                                                                                                                                                                          |
| `pending-pages.process.test.ts`                                                                                                                                                                                                                 | a     | Hundreds of large pending requests page and summarize; old cursors resume.                                                                                                                                                                                                              |
| `reply-bounds.process.test.ts`                                                                                                                                                                                                                  | a     | Replies stay inside their byte bounds.                                                                                                                                                                                                                                                  |
| `interaction-reads.test.ts`                                                                                                                                                                                                                     | b     | Request pages never split a UTF-16 pair. Checked through the store by `pending-pages.process.test.ts`.                                                                                                                                                                                  |
| `status-storage.process.test.ts`                                                                                                                                                                                                                | a     | Cold status loads without reading event bodies; approvals retained after thousands of answers.                                                                                                                                                                                          |
| `native-images.process.test.ts`                                                                                                                                                                                                                 | a     | Native image capture and backfill in small steps.                                                                                                                                                                                                                                       |
| `usage-replay.test.ts`, `usage-reads.process.test.ts`                                                                                                                                                                                           | a     | Usage replay budgets, deletion durability, bounded folding.                                                                                                                                                                                                                             |
| `migrations.process.test.ts`                                                                                                                                                                                                                    | a     | Schema 14 upgrades in place; credentials and folded records survive; backups deleted. Runs `migrate` on the connection, so it runs on the native connection as is.                                                                                                                      |
| `wal-maintenance.process.test.ts`                                                                                                                                                                                                               | a/b   | a: committed rows survive a crash; the WAL is empty after close. b: the failing-worker case injects the TS `CheckpointWorkerFactory`; on native the checkpointer is a Rust thread and the same behaviour (WAL stays bounded when the checkpointer fails) needs the native seam instead. |
| `history-storage.process.test.ts`, `history-publication-recovery.process.test.ts`                                                                                                                                                               | a     | Cancelled publication rolls back history and sequences; a lost worker reply publishes once.                                                                                                                                                                                             |
| `history-on-demand.process.test.ts`                                                                                                                                                                                                             | a     | History import creates one thread; leaves nothing behind. Mostly the history service.                                                                                                                                                                                                   |
| `long-thread-recovery.process.test.ts`, `long-thread-lifecycle.process.test.ts`, `long-thread-turns-page.test.ts`                                                                                                                               | a     | Long-thread backfill under contention, turn settlement, catch-up authorization, page shape.                                                                                                                                                                                             |
| `long-thread/decisions.test.ts`                                                                                                                                                                                                                 | b     | Pure liveness rule for subagents; no storage. Stays with whichever side owns the rule.                                                                                                                                                                                                  |
| `entity-shape.test.ts`, `entity-pages.property.test.ts`                                                                                                                                                                                         | a     | Entity rows decode with new defaults; pages never exceed 200.                                                                                                                                                                                                                           |
| `sidebar-columns.test.ts`                                                                                                                                                                                                                       | a     | Every tab, filter and project lists and counts as the JSON would; raw SQL changes move rows in the same transaction.                                                                                                                                                                    |
| `sidebar-live.process.test.ts`                                                                                                                                                                                                                  | a     | Live windows equal a fresh read through random changes.                                                                                                                                                                                                                                 |
| `sidebar-pagination.process.test.ts`, `sidebar-tabs.process.test.ts`, `sidebar-read-state.test.ts`, `sidebar-revisions.test.ts`                                                                                                                 | a     | Sidebar membership, order, tabs, cursors, read state, revision backfill.                                                                                                                                                                                                                |
| `sidebar-page-weight.test.ts`                                                                                                                                                                                                                   | b     | Page weight counts UTF-8 and escaping. Checked through the store by `sidebar-pagination.process.test.ts`.                                                                                                                                                                               |
| `activity-reads.server.process.test.ts`                                                                                                                                                                                                         | a     | Read marks survive restart and reach other devices.                                                                                                                                                                                                                                     |
| `search-replay-*.process.test.ts` (4), `search.outputs.process.test.ts`                                                                                                                                                                         | a     | Search rebuild in bounded pages, resume after restart, crossing deletion gaps.                                                                                                                                                                                                          |
| `subscription-replay.test.ts`, `subscription-snapshot.test.ts`, `subscription-tail.test.ts`                                                                                                                                                     | a     | Replay vs snapshot choice, current head on cached snapshots, small tails.                                                                                                                                                                                                               |
| `thread-delete.process.test.ts`, `thread-delete-crash.process.test.ts`, `thread-purge.process.test.ts`, `thread-gone.process.test.ts`, `deleted-thread-recovery.process.test.ts`                                                                | a     | Deletion and purge are durable, bounded and resume after a crash.                                                                                                                                                                                                                       |
| `daemon-crash-recovery.process.test.ts`, `shutdown-deadline.process.test.ts`                                                                                                                                                                    | a     | Crash and shutdown leave a consistent store.                                                                                                                                                                                                                                            |
| `engine/live-write-buffer.process.test.ts`, `engine/live-write-quarantine.process.test.ts`, `engine/storage-behaviour.process.test.ts`                                                                                                          | a     | The live path end to end through the engine: fewer than one commit per ten tokens, retry once, quarantine one session, recovery.                                                                                                                                                        |
| `agent-control/thread-read-paging.process.test.ts`                                                                                                                                                                                              | a     | Paging back ends cleanly; oversized raw payloads dropped, not the item.                                                                                                                                                                                                                 |
| `storage/compaction.process.test.ts`, `storage/space-reclaim.process.test.ts`, `storage/transcript-indexes.process.test.ts`, `storage/data-retention.process.test.ts`, `storage/retention*.process.test.ts`, `storage/recovery.process.test.ts` | a     | Compaction and reclaim never delete rows, wait for writers, resume after a kill; retention protections; never holding the event loop.                                                                                                                                                   |
| `storage/space-reclaim-policy.test.ts`, `storage/protection-equivalence.process.test.ts`                                                                                                                                                        | b     | Pure policy and protection planning over inventories; no storage engine. They stay TS until retention moves.                                                                                                                                                                            |
| `idle-store.perf.process.test.ts`                                                                                                                                                                                                               | c     | Checks the idle-performance bench's seeding script, not the store. Belongs with the bench (or `bench/check.ts`), not in the test suite.                                                                                                                                                 |

No (a) test reaches into store internals: of the store modules only `store-busy`,
`sequence-lineage`, `stored-shape`, `stored-trust-batch`, `thread-cache`, `thread-row`,
`interaction-reads`, `sidebar-placement`, `sidebar-page-storage`, `activity-reads` and
`migrations` are imported by tests at all, and in the (a) files only for helpers and options
that are part of the public surface (`isStoreBusy`, `lineageFile`, `storedEventShape`,
`migrate`).
