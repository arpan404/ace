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
  hold is released, deferred work starts as on any reopen, and anything put off (process
  inventory deletes) is retried. The gap between 256 and 512 MiB keeps one freed file from
  flapping admission.
- **Best-effort bookkeeping keeps its intent.** A process inventory delete that fails is kept in
  memory and retried. If the daemon dies first, recovery at the next start finds the process
  gone and removes the row, as it does today.
- **Unhandled rejections.** A disk-full rejection that nobody caught is logged and the daemon
  keeps running, as with store contention. The failed operation's transaction has already rolled
  back, and with new work held nothing builds on it. Crashing instead only restarts into the same
  full disk. Uncaught synchronous exceptions stay fatal; their sources are fixed one by one.

## Consequences

- A person who runs out of space sees why new work waits, and ace carries on once they free
  space. No restart or button is needed.
- `MaintenanceHold` gains `storage`, so `holds` may have five entries. Clients older than this
  change reject an admission message carrying it and show no admission state while it lasts.
- Running turns' output waits while the disk is full: the pinned batch stays in memory and new
  batches are turned back for their writers to retry, as under contention. Nothing is dropped.
- Free space read through `statfs` does not see per-user quotas, so on EDQUOT the hold can lift
  on the next read and be entered again by the next failed write. That costs a log line per read,
  not a crash.
