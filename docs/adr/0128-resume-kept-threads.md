# 0128: A kept thread resumes from its own cursor; the phone reads likely opens ahead

Date: 2026-11-11. Status: accepted. Decided by: the owner. Amends [ADR 0030](0030-client-sdk.md)
(amendment 2026-10-18, "restored store subscribes without `afterSeq`") and
[ADR 0105](0105-phone-chat-cache.md) ("threads the phone never opened are not fetched ahead").

## Context

A finished message never changes (ADR 0105), and the phone keeps every message it has seen on
disk. Yet switching between threads still waits on the machine, one thread at a time:

- **A thread read from disk is downloaded again whole.** `Subscriptions` marks a restored store
  `fresh`, so it subscribes without `afterSeq` and the daemon sends a snapshot of up to 200 items
  even when nothing changed. ADR 0030 did this because the record "may come from another daemon
  run".
- **The daemon judges replay by the whole host's traffic.** A thread subscription with `afterSeq`
  replays only when `head - afterSeq <= replayLimit` (5,000), and `seq` is one counter for the
  whole database. An agent streaming in another thread uses that up within minutes, so a quiet
  thread reopened later gets a full snapshot even through an in-memory resume.
- **Only threads already opened are kept.** The first open of each thread waits on the machine.

What a disk cursor can safely mean, from the daemon's store:

- Sequences are durable and monotonic per database. Ranges are reserved in `host_sequence`
  before volatile deltas go out, so a crash never reissues a sequence a client saw. A cursor past
  the surviving head, or inside a compacted delta span, already fails `replaySafe` and gets a
  snapshot.
- The one case that is not caught is another database under the same host id: `host-id` is a
  separate file, so a restored, reset or swapped `events.sqlite` restarts its sequences under the
  old id, and a cursor that lands on one of its rows replays the wrong history without error. The
  daemon already names each database with a random token made once (`sidebar_epoch`), but sends
  it only inside sidebar resume tokens.

## Options considered

- **Trust the host id alone.** Rejected: a restored database reuses sequences under it, and the
  replay would show history that never happened in this database.
- **Show a kept settled thread as confirmed without subscribing.** Rejected: a settled thread can
  be reopened from another device, and a copy that says Done while it works breaks priority 1.
- **Raise `replayLimit`.** Rejected: it still counts every thread's events, and a large limit
  makes the daemon read many rows to find a few.
- **Chosen:** send the database token, resume a disk copy only under the same token, and bound a
  thread's replay by that thread's events. Every unsafe case still falls back to today's snapshot.

## Decision

1. **The welcome names the database.** `welcome` gains an optional `databaseId`: the daemon's
   `sidebar_epoch` token, made once with the database. The fake daemon makes a fresh one each run,
   since its log lives in memory. Additive; the protocol version stays 1.
   A token inside the database rolls back with it, so the daemon also keeps a mark beside it
   (`sequence-mark.json`): the token and a sequence the database has committed, written at each
   reserved range and every 64 committed sequences, before clients hear of them. A database that
   opens with that token but below its mark was rolled back (a restored or copied
   `events.sqlite`) and takes a new token, so every kept cursor reads afresh. Two limits are
   accepted: a copy restored from within the last 64 durable sequences is not caught, and a
   restore of the whole data folder, mark included, cannot be told from the machine at all.
2. **A read record keeps the cursor's database.** A thread's read snapshot stores the `databaseId`
   it was confirmed under. Restored under the same `databaseId`, the store resumes with `afterSeq`
   like an in-memory one. A record without one, or with another, subscribes without `afterSeq`
   as before. When both are known and differ, the daemon's snapshot also replaces the copy instead
   of merging with it by sequence: another database's sequences say nothing about this one's. A
   new subscription waits for its record's first read (at most 250 ms) before it chooses its
   cursor, so an open on a live connection resumes too. A restored store is unconfirmed (Syncing)
   from its first notification until the replay or snapshot lands; nothing about what a cached
   thread shows changes.
3. **A thread's replay is bounded by its own events.** For a thread scope, the daemon reads that
   thread's events after `afterSeq`, up to `replayLimit + 1` and the existing 2 MiB budget, and
   replays them when they fit, however far the host's head has moved. More than that, or an unsafe
   cursor, gets a snapshot as today. Thread lists keep the global bound.
4. **The phone reads its likely opens ahead.** When the inbox lands, the bridge reads the few
   threads the person is most likely to open (still working or waiting first, then the most
   recently changed) through optional leases, one at a time, each released once it is confirmed.
   Optional leases take only spare subscription slots and give way to any thread the person
   opens. It runs only on an unmetered, unconstrained network and not in Low Power Mode, and
   never holds a subscription past the read. A read-ahead thread is kept in memory and on disk
   under ADR 0105's rules, like one the person opened.
5. **Native's shelf stays at six.** Laying out a thread that fell off the shelf
   (`ThreadShelf`) is cheap once its data is local: applying a whole finished thread took
   2.3–5.5 ms on the main thread (`ThreadOpenTrace` `mainApplyMs`, 143 patches, see Measured).
   The wait was the machine, which decisions 2–4 remove; a bigger shelf would hold memory for
   no visible gain.

Unchanged: ADR 0105's retention (seven days, every unsettled thread, twenty settled, 64 MiB), the
unconfirmed rule (a copy never reads Done before its machine answers), the host-id scoping of
records, and Settings → Cached chats.

## Measured

Debug build, iPhone 18 Pro Max simulator (iOS 27.0), spike fixture, `--spike-items 200`, the
finished thread `ios-done` opened at launch (`--spike-open`), four launches. Applying the open's
patches on the main thread took 2.3–5.5 ms (`mainApplyMs`). Ready times (731–2,130 ms) were
bound by launch, as ADR 0105 found, and varied too much between identical launches to compare
builds. Whether a reopen replays or reads a snapshot is pinned by tests, not timed here
(`apps/ios/bridge/read-snapshots.test.ts`).

## Consequences

- Reopening a thread kept on disk costs the events since it was last seen, usually none, instead
  of its whole window; it leaves Syncing after one round trip.
- The first open of a likely thread paints from memory on Wi-Fi.
- Read-ahead spends some data and machine work on threads the person may not open. It is capped,
  sequential, Wi-Fi only and yields to every real open.
- Older daemons send no `databaseId`; clients then behave as before.
- The daemon's thread replay now reads by the `events_thread_seq` index, not a global range.

## Tests

- A restored record resumes with `afterSeq` under the same `databaseId`, and without it under a
  different or missing one (`packages/client`).
- A thread subscription replays its few events after a cursor behind more than `replayLimit` host
  events, and sends a snapshot past the thread's own bound (`apps/daemon`).
- A phone's kept copy from an earlier run of the fixture under the same host id reads afresh, and
  one from the same run resumes with no snapshot, over the iOS row storage (`apps/ios/bridge`).
- A copy from another database is replaced, not merged; a restored copy is never seen confirmed;
  an open on a live connection waits for its copy and resumes (`packages/client`).
- A database rolled back behind its mark is named afresh, and one reopened as it was keeps its
  name (`apps/daemon/src/sequence-lineage.test.ts`).
- Read-ahead reads the chosen threads, releases each, stops off Wi-Fi, and never takes the slot of
  a thread the person opens (`apps/ios/bridge`).
