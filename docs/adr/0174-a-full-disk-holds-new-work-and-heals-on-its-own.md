# 0174: A full disk holds new work and heals on its own

Date: 2026-11-16. Status: accepted.

## Context

On 2026-11-12 and 13 one person's daemon (0.0.23) crashed 12 times with `database or disk is
full` (SQLITE_FULL) while 111–127 MB were free. The throw came from the process inventory's
`DELETE FROM processes`, run synchronously in a child process's exit listener, where nothing
caught it. Every restart met the same disk, so the daemon kept dying.

Fixing that one call is not enough. With the disk full, every write the daemon makes can fail:
event rows, live output, receipts, logs. Before this decision the daemon handled each failure
on its own terms. Live output that failed six times in a row was quarantined: dropped, and the
session stopped with "Recent output could not be saved". A disk-full rejection nobody caught was
fatal. Nothing told the person why work was failing.

## Decision

A full disk is a daemon-wide condition, `storage`, that ace enters and leaves by itself.

- **Entering.** The first failure classified as a full disk (SQLITE_FULL, ENOSPC or EDQUOT in the
  cause chain, `isDiskFull` in `sqlite-failure.ts`) enters it, wherever the daemon hears of it:
  the event store's error reports, the process inventory, background passes, and unhandled
  rejections. Free space under 256 MiB on the volume holding ACE_HOME also enters it, before any
  write fails. Under 1 GiB the daemon only logs a warning.
- **While in it.** The admission gate (ADR 0041) takes a `storage` hold. New threads, turns and
  messages wait; interrupts, approvals and stops still go through, and running turns go on.
  Their live output stays in memory and is retried on the usual backoff, never quarantined for
  a full disk: a full disk says nothing about the rows. Clients show one plain line, "The disk is
  full · new work resumes once space is freed", and nothing to press.
- **Leaving.** Free space is read every 60 s, and every 5 s while held. At 512 MiB or more the
  hold is released (after a probe write, when a refused write began it), deferred work starts
  as on any reopen, and anything put off (process inventory deletes) is retried. The gap between 256 and 512 MiB keeps one freed file from
  flapping admission.
- **A full disk is a retry, not a failure.** `isStoreRetry` counts it, as it counts contention:
  a thread actor applying provider frames waits and tries again instead of stopping the session,
  and so do the other writers that already retried on a busy store.
- **Best-effort bookkeeping keeps its intent.** A process inventory delete that fails is kept in
  memory and retried. If the daemon dies first, recovery at the next start finds the process
  gone and removes the row, as it does today. The thread organizer's and workspace refresh's
  "look at this thread again" marks work the same way (`held-writes.ts`): a refused mark is
  written first on the owner's next pass, and again as soon as space is back. Their start-up
  passes mark every thread, so a crash loses none.
- **A child waits, it does not fail.** A delegated child whose start the full disk rolls back
  stays queued, as when the engine has no room, and starts on the next retry once space is back.
  Its parent keeps showing it waiting.
- **Starting on a full disk.** On a disk with no free block SQLite can't open a WAL database
  at all, not even to read: a clean close removed its `-wal` and `-shm` files and they can't be
  made again. So ace keeps a reserve, a 16 MiB file `storage-reserve` in ACE_HOME, written while
  there is room (`storage-reserve.ts`). A daemon that starts with free space under `pauseBelow`
  removes it before anything else opens, and the storage watch removes it whenever the hold is
  entered. The daemon then comes up as usual with the hold on: reads work, new work waits, and
  its own first writes and held writes have room. The watch never counts a removed reserve as
  free space, so only space the person frees lifts the hold; once it lifts, the reserve is
  written again. The home's lock takes its exclusive transaction with an in-memory journal, so
  taking it makes no file, and only a lock another daemon holds is reported as one. A home with
  no reserve yet (the first start after upgrading) on a disk with no block left still can't
  start: its stores fail to open with `DiskFullAtStartError`, which names the free space,
  instead of "unable to open database file". Nothing can be logged or published there either.
  This sits under ADR 0175: the lock and the event store stay fatal to a start, and the reserve
  is what lets them open.
- **Children wait while held.** A child another machine delegates here checks admission as a
  local one does: while new work is held it queues and its caller is told so; nothing starts it
  until admission reopens, which drains the queue at once. Retries while held, or after a start
  the full disk rolled back, back off from 1 s to 30 s. While the storage hold lasts, a queued
  child, local or remote, reads "Waiting for disk space" (`QueueFacts.waitingFor`).
- **Unhandled rejections.** A disk-full rejection that nobody caught is logged and the daemon
  keeps running, as with store contention. The failed operation's transaction has already rolled
  back, and with new work held nothing builds on it. Crashing instead only restarts into the same
  full disk. Uncaught synchronous exceptions stay fatal; their sources are fixed one by one.

## Consequences

- A person who runs out of space sees why new work waits, and ace carries on once they free
  space. No restart or button is needed.
- `MaintenanceHold` gains `storage`, so `holds` may have five entries. Builds older than this
  change reject any message carrying it, so only a client whose hello lists the `storage-hold`
  trim is sent it. Other clients hear it as `user`, the person's pause: old builds still show
  that new work is paused, and their Resume changes nothing until space is freed. The host
  token's HTTP answers (`/v1/status`, `/v1/maintenance`) leave the hold out and still read
  `draining`: the local app's main process only asks whether the person paused, and an older one
  would read the daemon as unhealthy instead.
- Running turns' output waits while the disk is full: the pinned batch stays in memory and new
  batches are turned back for their writers to retry, as under contention. Nothing is dropped.
- Free space read through `statfs` does not see per-user quotas. So a hold that a refused write
  began (EDQUOT among them) is not lifted on free space alone: once the volume reads room, the
  watch writes, syncs and removes 1 MiB under ACE_HOME, and lifts the hold only if that goes
  through. Only a full-disk error fails the probe, so an unrelated error can never keep new work
  held. A quota with less than that left can still let the hold lift and come back, one log line
  each time, never a crash.
