# 0177: A gone thread has one owner

Date: 2026-11-17. Status: accepted.

## Context

On one person's Mac (ace 0.0.23, a 14 GB `events.sqlite`), agent control failed at every daemon
start with `Missing engine state`, and took machines, transfers and external MCP down with it,
since they depend on it. A parent thread had been deleted, then purged by storage cleanup: its
`threads` row stayed as a tombstone, but its `thread_state` and transcript went. Two of its
delegations were settled while their children were still `limited`, so recovery read them again
and reported them to the parent through the engine, which has no state for it. Nothing caught the
throw. The same gap made the machine-children poll fail once a second for 26 hours, re-reading
settled children of that parent.

Deleting a thread was not one operation. Four code paths wrote the tombstone (the thread
lifecycle, project removal, the removed-project sweep, storage cleanup) and only the first ran the
deletion policy that cancels a thread's running descendants. Purging removed some rows keyed by
the thread and left every row in another table that names it: delegation edges, machine children,
transfers, engine session rows. Readers of those rows assumed the thread was still there.

## Decision

`apps/daemon/src/thread-gone.ts` owns what it means for a thread to be gone.

- **Retiring.** Every path that deletes a thread calls `retireThread`, which runs the deletion
  policy (`Engine.prepareDeletion`, bound to `DelegationService.cancelDescendants`) and writes the
  tombstone in one transaction. The thread lifecycle runs the policy when it admits the delete and
  stops the tree before it writes the tombstone, so it writes it with `tombstone`.
- **Purging.** Every purge calls `purgeThread`: the thread's data goes and the purge is recorded in
  one transaction. The `threads` row stays as the tombstone.
- **Reading.** A thread is gone when it is deleted or the engine holds no state for it
  (`threadGone`). Every reader that may meet a reference to another thread checks it first and
  treats a gone thread as gone, never as an error: nothing is applied to it in the engine.
- **Closing references.** The tombstone is the signal. Agent control settles a deleted thread's
  open child edges as cancelled with their wakes suppressed, and never revives a settled edge for
  a gone parent. Machine children of a gone parent leave the re-check, and an open one is stopped
  as its parent's deletion stops it. A transfer of a gone thread ends without a hold. The
  notification log passes over events for a thread whose creation was purged.
- **Healing.** Rows an older build left open heal at start: recovery settles or skips them, and an
  edge that still fails to recover is reported through `onError` without stopping agent control.
- **Never done while running.** A gone parent's still-running children are cancelled by the
  deletion policy, or run on as their own threads; their own status is never changed to done for
  it.

## Consequences

- A new table that names another thread must say what happens to its rows when that thread goes,
  and its readers must use `threadGone`. `thread-gone.process.test.ts` is the invariant: a tree
  retired through every deletion path, purged and restarted brings every service up with nothing
  open naming the gone parent.
- Rows are settled, not deleted: a gone thread's children, their results and their history stay
  readable. Nothing else of the person's is removed.
- Tombstones are still written outside the transaction that admits a delete (the lifecycle stops
  the tree in between, ADR 0170 keeps that work off the main path), so closing references happens
  as agent control reads the tombstone, and again at the next start if it was down.
