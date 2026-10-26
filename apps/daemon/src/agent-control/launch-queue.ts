import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import { startsLater } from "./failure.ts";

const Entry = z.object({ child_id: ThreadId, parent_id: z.string(), text: z.string() });
/**
 * A child waiting to start. `parentId` names whose run slots it waits for: the delegating
 * thread here, or for a child another machine delegated, that machine's calling thread.
 */
export type QueuedLaunch = { childId: ThreadId; parentId: string; text: string };
/** Local delegations and children other machines delegate here wait in separate tables. */
export type LaunchTable = "delegation_launch_queue" | "machine_launch_queue";

/**
 * Children admitted while their parent's run slots were full. Each waits here, durably and in
 * arrival order, until a slot frees. Nothing here is ever refused because of a count.
 */
export class LaunchQueue {
  private store: Store;
  private table: LaunchTable;
  constructor(store: Store, table: LaunchTable = "delegation_launch_queue") {
    this.store = store;
    this.table = table;
    const order =
      table === "delegation_launch_queue" ? "delegation_launch_order" : `${table}_order`;
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        child_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        parent_id TEXT NOT NULL, text TEXT NOT NULL, seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${order} ON ${table}(parent_id,seq);
      CREATE INDEX IF NOT EXISTS ${table}_seq ON ${table}(seq);
    `),
    );
  }
  /** One indexed probe, cheap enough for hot paths: true while any child waits for a slot. */
  waiting(): boolean {
    return !!this.store.statement(`SELECT 1 FROM ${this.table} LIMIT 1`).get();
  }
  has(child: ThreadId): boolean {
    return !!this.store.statement(`SELECT 1 FROM ${this.table} WHERE child_id=?`).get(child);
  }
  add(launch: QueuedLaunch): void {
    this.store.atomic((db) => {
      // The seq index answers MAX from its last entry, without scanning the queue.
      const next = Number(
        this.store.statement(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM ${this.table}`).get()?.n,
      );
      db.prepare(`INSERT OR IGNORE INTO ${this.table} VALUES (?,?,?,?)`).run(
        launch.childId,
        launch.parentId,
        launch.text,
        next,
      );
    });
  }
  take(child: ThreadId): QueuedLaunch | undefined {
    const row = this.store
      .statement(`SELECT child_id,parent_id,text FROM ${this.table} WHERE child_id=?`)
      .get(child);
    if (!row) return undefined;
    this.store.statement(`DELETE FROM ${this.table} WHERE child_id=?`).run(child);
    const entry = Entry.parse(row);
    return { childId: entry.child_id, parentId: entry.parent_id, text: entry.text };
  }
  /** Every waiting child of one parent, oldest first: positions shift as the head starts. */
  ordered(parent: string): ThreadId[] {
    return this.store
      .statement(`SELECT child_id FROM ${this.table} WHERE parent_id=? ORDER BY seq`)
      .all(parent)
      .map((row) => ThreadId.parse(row.child_id));
  }
  /**
   * Up to `limit` waiting children of one parent queued after `afterSeq`, oldest first: one
   * indexed range read, so starting the head costs the same however long the queue is.
   */
  head(parent: string, afterSeq: number, limit: number): { childId: ThreadId; seq: number }[] {
    return this.store
      .statement(
        `SELECT child_id,seq FROM ${this.table} WHERE parent_id=? AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(parent, afterSeq, limit)
      .map((row) => ({ childId: ThreadId.parse(row.child_id), seq: Number(row.seq) }));
  }
  parents(): string[] {
    return this.store
      .statement(`SELECT DISTINCT parent_id FROM ${this.table} ORDER BY parent_id`)
      .all()
      .map((row) => z.string().parse(row.parent_id));
  }
}

/**
 * Starts `launch` now when its parent has a free slot, or queues it. An engine that is full or
 * still starting is a wait, not a refusal: the launch queues like any other. Any other failure
 * to start is the caller's.
 */
export function startOrQueue(
  queue: LaunchQueue,
  launch: QueuedLaunch,
  slots: number,
  start: () => void,
): "started" | "queued" {
  if (slots > 0)
    try {
      start();
      return "started";
    } catch (error) {
      if (!startsLater(error)) throw error;
    }
  queue.add(launch);
  return "queued";
}

/** Most entries one drain reads at a time, when the limit leaves many slots free. */
const DRAIN_BATCH = 32;

/**
 * Starts the oldest waiting launches of one parent until `slots` of them have started or the
 * engine can't take more yet (full, or still starting). Each is taken and started in one
 * transaction, so such an engine leaves it queued and ends the drain, answering "later" for
 * callers that retry only then. A launch that is
 * skipped (`start` returns "skipped": stopped, gone) or fails for any other reason goes to
 * `failed` and uses no slot, so the children queued behind it still start now.
 */
export function drainLaunches(
  store: Store,
  queue: LaunchQueue,
  parent: string,
  slots: number,
  start: (launch: QueuedLaunch) => "started" | "skipped",
  failed: (child: ThreadId, error: unknown) => void,
): "drained" | "later" {
  let started = 0;
  // A cursor past each entry tried, so one left queued by a failure is not tried again here.
  let cursor = 0;
  while (started < slots) {
    // Only as many as the free slots, so releasing one slot reads one entry; more are read
    // only to replace entries that failed or were skipped.
    const batch = queue.head(parent, cursor, Math.min(slots - started, DRAIN_BATCH));
    if (!batch.length) break;
    for (const { childId: child, seq } of batch) {
      cursor = seq;
      try {
        const outcome = store.atomic(() => {
          const launch = queue.take(child);
          return launch ? start(launch) : "skipped";
        });
        if (outcome === "started" && ++started >= slots) return "drained";
      } catch (error) {
        if (startsLater(error)) return "later";
        failed(child, error);
      }
    }
  }
  return "drained";
}
