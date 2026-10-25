import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import { engineFull } from "./failure.ts";

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
    const order = table === "delegation_launch_queue" ? "delegation_launch_order" : `${table}_order`;
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        child_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        parent_id TEXT NOT NULL, text TEXT NOT NULL, seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${order} ON ${table}(parent_id,seq);
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
      const next = Number(
        db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM ${this.table}`).get()?.n,
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
  /** The oldest waiting children of one parent; an unbounded limit returns them all. */
  next(parent: string, limit: number): ThreadId[] {
    if (limit <= 0) return [];
    return this.store
      .statement(`SELECT child_id FROM ${this.table} WHERE parent_id=? ORDER BY seq LIMIT ?`)
      .all(parent, Number.isFinite(limit) ? limit : -1)
      .map((row) => ThreadId.parse(row.child_id));
  }
  parents(): string[] {
    return this.store
      .statement(`SELECT DISTINCT parent_id FROM ${this.table} ORDER BY parent_id`)
      .all()
      .map((row) => z.string().parse(row.parent_id));
  }
}

/**
 * Starts `launch` now when its parent has a free slot, or queues it. A full engine is a wait,
 * not a refusal: the launch queues like any other. Any other failure to start is the caller's.
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
      if (!engineFull(error)) throw error;
    }
  queue.add(launch);
  return "queued";
}

/**
 * Starts the oldest waiting launches of one parent into its free slots. Each is taken and
 * started in one transaction, so a full engine leaves it queued and ends this drain; any other
 * failure goes to `failed`, so a launch that can never start does not wait forever.
 */
export function drainLaunches(
  store: Store,
  queue: LaunchQueue,
  parent: string,
  slots: number,
  start: (launch: QueuedLaunch) => void,
  failed: (child: ThreadId, error: unknown) => void,
): void {
  for (const child of queue.next(parent, slots)) {
    try {
      store.atomic(() => {
        const launch = queue.take(child);
        if (launch) start(launch);
      });
    } catch (error) {
      if (engineFull(error)) return;
      failed(child, error);
    }
  }
}
