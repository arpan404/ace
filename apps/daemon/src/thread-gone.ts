import type { Thread, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

/*
 * The one owner of "this thread is gone" (ADR 0177). A thread goes in two steps: it is retired
 * (its deletion policy runs and its tombstone is written, together), then its data may be purged
 * (its transcript and engine state removed; the `threads` row stays). Every path that deletes a
 * thread goes through `retireThread`, and every purge through `purgeThread`. What still refers to
 * a gone thread reads it as gone through `threadGone`, never as an error.
 */

/** Runs the deletion policy for a thread: its running descendants are cancelled. */
export type DeletionPolicy = (id: ThreadId, commandId: string) => void;

/**
 * A thread nothing can report to or show anything in any more: it was deleted, or the engine
 * holds no state for it (its data was purged). Without an engine, only the deletion is known.
 */
export function threadGone(
  thread: (id: ThreadId) => Pick<Thread, "deletedAt"> | undefined,
  engine: { hasState(id: ThreadId): boolean } | undefined,
  id: ThreadId,
): boolean {
  if (thread(id)?.deletedAt !== undefined) return true;
  return engine !== undefined && !engine.hasState(id);
}

/**
 * Retires a thread in one transaction: the deletion policy cancels what still runs under it
 * (when an engine is there to run it), then its tombstone is written. Agent control settles the
 * edges of its children as it reads the tombstone. A thread already deleted is left as it is.
 */
export function retireThread(
  store: Store,
  id: ThreadId,
  at: number,
  policy: DeletionPolicy | undefined,
  commandId: string,
): void {
  store.atomic(() => {
    const thread = store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) return;
    policy?.(id, commandId);
    tombstone(store, id, at);
  });
}

/**
 * Writes the tombstone of a thread whose deletion policy already ran (the thread lifecycle runs
 * it when it admits the delete, then stops the tree before this).
 */
export function tombstone(store: Store, id: ThreadId, at: number): void {
  store.appendEvents(
    id,
    [{ type: "thread.client.updated", changes: { deletedAt: at, autoSettleAt: null } }],
    at,
  );
}

/**
 * Purges a retired thread's data and records that it was purged, in one transaction. The
 * `threads` row stays as its tombstone, so everything that still names it reads it as gone.
 */
export function purgeThread(store: Store, id: ThreadId, at: number): void {
  store.atomic(() => {
    store.purgeThreadData(id);
    store.statement("INSERT OR REPLACE INTO storage_purged VALUES (?,?)").run(id, at);
  });
}
