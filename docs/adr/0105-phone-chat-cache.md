# 0105: The phone's chat cache: one row per item, seven days, twenty settled

Date: 2026-10-26. Status: accepted. Amends [ADR 0030](0030-client-sdk.md) (read snapshots),
[ADR 0074](0074-native-ios-client.md) and [ADR 0096](0096-native-host-contract.md).

## Context

The phone paints a thread from disk before its machine answers (ADR 0030). Until now the SDK's
read snapshot of a thread was one JSON record (`thread:<id>`) holding the whole window, and the
iPhone's `SnapshotStore` kept those records whole, evicting the least recently used past 256
records or 32 MiB. Every write rewrote the whole thread: while an agent streamed, about once a
second, the bridge serialized and Swift stored the full 200-item window to change one message.
Two threads that shared nothing still competed under one count, so a few long ones pushed out
everything else, whatever was still running. The bridge's kept service reads had their own
limit of 120 answers.

The owner set the rules on 2026-10-26:

- A finished message never changes. Keep it once; only the live tail of a running thread changes.
- Keep every unsettled thread (working, waiting, needing the person, done but not settled).
- Of settled threads, keep the most recently opened twenty.
- Let anything go seven days after its last use, instead of the 120-entry limit.
- Store each message once: no copies of the same transcript.
- Logic in shared JS, so Android reuses it; native code only stores.
- Settings shows what is kept and clears it, per machine and in all; a thread can be reloaded
  from its machine.

## Decision

### What is stored

Per machine and device (the SQLite file beside that machine's outbox, as before), three tables:

| Table       | Key                   | Holds                                                                                                                                                         |
| ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threads`   | record key            | the head: the record without its items (thread, agents, runs, interactions, tasks, usage, item order and creation sequences), whether it is settled, last use |
| `items`     | (record key, item id) | one item's JSON                                                                                                                                               |
| `snapshots` | record key            | other records whole (the inbox list), with last use                                                                                                           |

The record key is the SDK's own (`<daemon host id>/thread:<id>`), so the machine and daemon
identity are part of every key. An item is held once; the head refers to it by id.

### What is written

`RowSnapshots` (`@ace/client`) implements the SDK's `ReadSnapshotStorage` over a platform's
`SnapshotRows`. On each thread write it sends the head, the items it has not stored as finished,
and the ids that left the window. An item is finished when it is complete and is not a tool call
still pending, awaiting approval or running (`itemFinished`, also what the thread store merges
by). A finished item is written the first time it is seen finished and never again, including
after a relaunch: items read back from disk count as stored. A write is all or nothing; after one
fails, the next replaces the thread whole. A whole-thread record left by an earlier build is
dropped.

The SDK is unchanged above the storage: it still checkpoints a thread's record at most once a
second and on close, and still never resumes from a disk copy's cursor. What changed is the cost
of each write: the head plus the streaming tail, not the transcript.

### What goes

`expiredSnapshots` (`@ace/client`, pure, clock passed in) decides; the platform deletes:

1. Anything unused for seven days goes. Use is a read or a write, stamped by the platform.
2. Unsettled threads stay whatever their number. Settled means what the inbox shows as settled
   (`sidebarSettled`), read from the head at each write.
3. Of settled threads, the twenty most recently used stay.
4. A 64 MiB safety net: past it, the least recently used go, settled threads first, then other
   records, then unsettled threads; the most recently used entry always stays.

It runs once per launch, when a thread is kept (again, after a clear or a drop), when a kept
thread settles or unsettles, and after every sixteenth of the byte cap written, one sweep at a
time. Swift no longer evicts anything itself.

Reads, writes and pruning race on one serial storage queue. A clear moves a global generation
and every write, drop and delete moves a per-key one; a read or listing taken before either moved
is discarded before it shows anything or changes what the adapter believes storage holds. A
thread let go while its last checkpoint is still queued is discarded with it on clear or reload,
so that checkpoint never lands after the drop. Reload from machine carries the message's staged
files to the reopened thread.

The bridge's kept service reads (`read-cache.ts`) drop their 120-answer limit for the same
seven-day age, with a 500-answer and 1.5 M-character budget as the safety net.

### Correctness

A thread read from disk is unconfirmed until its machine answers, as before (ADR 0030): it reads
Syncing, never Done, and the machine's snapshot replaces it. Settled state decides only how long
a copy is kept, never what is shown.

### Clearing and reloading

`ClientCore.forgetThread(id)` drops a thread's store (when no view holds it) without writing its
snapshot back, and deletes its rows. `ClientCore.clearReadSnapshots()` drops every read snapshot
of the machine and every store no view holds; a thread still open stays live and is kept again.
Neither touches the outbox, drafts or kept settings. The bridge (`chat-cache.ts`) answers
`cache.read` with the thread count and the store's size on disk, `cache.clear`, and
`cache.reload`, which leaves an open thread, forgets it and opens it again cold, so it comes from
the machine. Settings → Cached chats shows the total and each machine, with Clear per machine and
Clear cached chats for all, each behind a confirmation. The thread's ⋯ menu has Reload from
machine.

### Host contract

Added to `HostOperations` (additive, version stays 1): `snapshot.thread.get`,
`snapshot.thread.put`, `snapshot.index`, `snapshot.drop`, `snapshot.size`. A thread travels as
newline-separated JSON (head first), since JSON never holds a raw newline, and is parsed in one
`JSON.parse`. Android implements the same five operations over its own SQLite.

## Measured

Perf build, iPhone Air simulator (iOS 27.0), no-quota fixture, `--spike-open` at launch, five
launches each (the first with nothing cached). The Mac was shared with other work, so absolute
numbers vary by run; the same fixture served both builds back to back.

| Open after relaunch (median of launches 2–5) | Before (blob) | After (rows) |
| -------------------------------------------- | ------------- | ------------ |
| Long live thread, ready                      | 686 ms        | 707 ms       |
| Finished thread, ready                       | 551 ms        | 565 ms       |

With `-ace-host-trace`, reading the long thread back from rows took 0.2–0.4 ms in SQLite, and
each thread write took 1–3 ms (a whole-blob write took 2–3 ms plus serializing the whole window
in the script). The open after a relaunch is bound by launch work, not storage: the bridge's
first frame reaches the main thread about 400 ms after the script starts, while the inbox is laid
out. That is where a faster reopen has to come from.

## Consequences

- Streaming no longer rewrites the transcript to disk; a long finished thread costs nothing per
  write.
- Unsettled threads are never pushed out by count. Threads the phone never opened are not
  fetched ahead: caching every unsettled thread up front would hold a subscription per thread and
  is left for later.
- History pages read beyond the snapshot window are not kept on disk; scrolling far back after a
  relaunch still reads them from the machine.
