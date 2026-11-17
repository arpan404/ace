import { setImmediate } from "node:timers/promises";
import { ThreadId, type Thread } from "@ace/protocol";
import type { Store } from "./store.ts";
import { purgeTranscriptBatch, transcriptPurgePlan } from "./storage/transcript.ts";

/*
 * The one owner of "this thread is gone" (ADR 0177). A thread goes in two steps: it is retired
 * (its deletion policy runs and its tombstone is written, together), then its data may be purged
 * (its transcript and engine state removed, in bounded batches; the `threads` row stays). Every path that deletes a
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

/** How a purge paces itself: rows per write, the pause between writes, and whether to go on. */
export interface PurgePace {
  batch: number;
  idle(): Promise<void>;
  going(): boolean;
}
/** Short writes, each followed by a turn of the event loop for sockets, stops and other writers. */
export const IDLE_PURGE: PurgePace = {
  batch: 512,
  idle: () => setImmediate(),
  going: () => true,
};

/**
 * Purges a retired thread's data a batch at a time, then, in one small transaction, its engine
 * state and the engine's own rows, and records the purge. Its tombstone keeps it gone to every
 * reader throughout. The purge is noted first, so one a restart or a stop cut short is finished
 * by `resumePurges`. True once purged; false when `pace.going()` stopped it first.
 */
export async function purgeThread(
  store: Store,
  id: ThreadId,
  at: number,
  pace: PurgePace = IDLE_PURGE,
): Promise<boolean> {
  if (purged(store, id)) return true;
  store.atomic(() =>
    store.statement("INSERT OR IGNORE INTO thread_purges VALUES (?,?)").run(id, at),
  );
  const plan = store.atomic((db) => transcriptPurgePlan(db));
  let step = 0;
  for (;;) {
    await pace.idle();
    if (!pace.going()) return false;
    await store.writable();
    const progress = store.atomic((db) => purgeTranscriptBatch(db, id, plan, pace.batch, step));
    if (progress.changed === 0) break;
    step = progress.step;
  }
  store.atomic(() => {
    // Another purge of the same thread may have finished it meanwhile.
    if (purged(store, id)) return;
    store.purgeThreadData(id);
    store.statement("INSERT OR REPLACE INTO storage_purged VALUES (?,?)").run(id, at);
    store.statement("DELETE FROM thread_purges WHERE thread_id=?").run(id);
  });
  return true;
}

/** Finishes every purge a restart or a stop cut short, oldest first. */
export async function resumePurges(
  store: Store,
  at: () => number,
  pace: PurgePace,
  finished: (id: ThreadId) => void,
): Promise<void> {
  for (;;) {
    const row = store
      .statement("SELECT thread_id FROM thread_purges ORDER BY started_at, thread_id LIMIT 1")
      .get();
    if (!row || !pace.going()) return;
    const id = ThreadId.parse(row.thread_id);
    if (!(await purgeThread(store, id, at(), pace))) return;
    finished(id);
  }
}

function purged(store: Store, id: ThreadId): boolean {
  return store.statement("SELECT 1 FROM storage_purged WHERE thread_id=?").get(id) !== undefined;
}
