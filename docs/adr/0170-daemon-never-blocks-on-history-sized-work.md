# 0170: The daemon never blocks on work that grows with history

Date: 2026-11-15. Status: accepted. Decided by: the owner.

## Context

The daemon's main thread runs the socket, the event writer and the stop handler. While it is
busy in one synchronous call, nothing else runs: clients can't connect and see only "Syncing…",
the stall watchdog reports a freeze, and SIGTERM waits, so the desktop supervisor kills the
daemon after its 10 s grace.

On 2026-11-15 the first launch after updating to 0.0.22 froze this way for at least 48 s, before
the daemon listened. The cause was two `CREATE INDEX` statements and one full-table `UPDATE`
added to the event store's open (`Store` constructor). Measured on an APFS clone of the owner's
home (34 GB `events.sqlite`, 2.18 M `history_item_revisions` rows), the first open after the
upgrade took 81–106 s with a cold page cache, 76–101 s of it in one `CREATE INDEX`. The same
open took 2–15 s with a warm cache and 0.14 s once done. Tests and development homes are small
and warm, so nothing caught it before release (fixed in #2156).

Normal starts had the same class of problem at a smaller size: usage recovery re-read about 64k
rows of already-counted history on every start, about 5 s cold, after listen and before the
daemon reported ready (fixed in #2157). `threadsWithOpenTasks` and `RunCheckpoints` still read
tens of thousands of rows cold before listen (about 3 s and 0.7 s).

## Options considered

- **Keep heavy steps at open and show "Upgrading storage…".** Rejected: the main thread still
  can't answer the socket or a stop signal, and every launch after an update would wait minutes
  on a large home.
- **Run the heavy step on another connection while the daemon runs.** Rejected for writes:
  `CREATE INDEX` or a full-table `UPDATE` holds SQLite's write lock for its whole length, so the
  daemon's own writes fail after `busy_timeout`.
- **Bound every open-time step by the size of the change, and move history-sized work into idle,
  bounded batches (chosen).** The daemon listens and answers within seconds on any home. Work
  that needs a full pass becomes data kept current as rows are written, plus a background fill.
  Until the fill is complete, readers fall back to the slower path that is already correct.

## Decision

1. **Nothing on the daemon's startup path or main thread does work proportional to stored
   history.** That covers the store's open, migrations, service factories and everything that
   runs before the daemon is handed to clients. Each such step is O(1) or proportional to what
   changed since the last run, and must stay so on a cold page cache.
2. **No migration or open-time pass builds an index on, or rewrites every row of, a table that
   grows with history.** Use a column default or a reader that treats the default correctly, or
   a side table kept current by the writers or triggers and filled in idle batches by rowid or
   primary key. A fresh home's empty tables may be set up at once.
3. **Background passes run in bounded batches on idle ticks**, each batch small enough not to
   stall the event loop, with progress saved, so a crash or stop resumes rather than restarts.
   A pass that needs complete data (such as the stored-trust pass, ADR 0125) does nothing until
   its fill is complete; it never trusts or decides from partial data.
4. **Startup work that rescans history every start records how far it got,** so the next start
   reads only what was written since (as usage recovery does after #2157).
5. **Agent state is never deferred to make startup faster.** Whatever decides whether an agent
   is working, waiting or done still finishes before the daemon reports it (AGENTS.md priority 1).
   Batching and deferral apply only to optimisations and derived data.
6. **A change that adds open-time work is measured on a large home with a cold cache.** Make an
   APFS `cp -c` clone of a real or seeded large `events.sqlite`, roll it back to the previous
   release's layout, copy it again under a new name (a new file has a cold cache) and time the
   first open. The live `~/.ace` databases are never opened for this.

## Consequences

- Upgrades that need a new index or backfill take more code: a side table or a reader-side
  default, triggers or writer hooks, and an idle fill with a completion marker.
- Reads that the new data would speed up stay on their slower, correct path for a while after an
  update.
- Side tables can be larger than the index they replace (`stored_trust_rows` is 108 MB against
  25 MB on the owner's home); that is accepted.
- `threadsWithOpenTasks` and `RunCheckpoints` break decision 1 today and should move to this
  pattern.

## Tests

- `apps/daemon/src/stored-trust-rows.test.ts`: a home from before the side table opens without
  building the old indexes, and the trust pass trusts nothing until the fill completes.
- `apps/daemon/src/agent-control/local-usage-recovery.test.ts`: a restart does not read again the
  history the last start went through, yet still finds new usage.
