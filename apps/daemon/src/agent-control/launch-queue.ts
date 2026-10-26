import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

const Entry = z.object({ child_id: ThreadId, parent_id: ThreadId, text: z.string() });
export type QueuedLaunch = { childId: ThreadId; parentId: ThreadId; text: string };

/**
 * Children admitted while their parent's run slots were full. Each waits here, durably and in
 * arrival order, until a slot frees. Nothing here is ever refused because of a count.
 */
export class LaunchQueue {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS delegation_launch_queue (
        child_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        parent_id TEXT NOT NULL, text TEXT NOT NULL, seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delegation_launch_order ON delegation_launch_queue(parent_id,seq);
    `),
    );
  }
  /** One indexed probe, cheap enough for hot paths: true while any child waits for a slot. */
  waiting(): boolean {
    return !!this.store.statement("SELECT 1 FROM delegation_launch_queue LIMIT 1").get();
  }
  has(child: ThreadId): boolean {
    return !!this.store
      .statement("SELECT 1 FROM delegation_launch_queue WHERE child_id=?")
      .get(child);
  }
  add(launch: QueuedLaunch): void {
    this.store.atomic((db) => {
      const next = Number(
        db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM delegation_launch_queue").get()?.n,
      );
      db.prepare("INSERT OR IGNORE INTO delegation_launch_queue VALUES (?,?,?,?)").run(
        launch.childId,
        launch.parentId,
        launch.text,
        next,
      );
    });
  }
  take(child: ThreadId): QueuedLaunch | undefined {
    const row = this.store
      .statement("SELECT child_id,parent_id,text FROM delegation_launch_queue WHERE child_id=?")
      .get(child);
    if (!row) return undefined;
    this.store.statement("DELETE FROM delegation_launch_queue WHERE child_id=?").run(child);
    const entry = Entry.parse(row);
    return { childId: entry.child_id, parentId: entry.parent_id, text: entry.text };
  }
  /** The oldest waiting children of one parent. */
  next(parent: ThreadId, limit: number): ThreadId[] {
    if (limit <= 0) return [];
    return this.store
      .statement(
        "SELECT child_id FROM delegation_launch_queue WHERE parent_id=? ORDER BY seq LIMIT ?",
      )
      .all(parent, limit)
      .map((row) => ThreadId.parse(row.child_id));
  }
  /** Every waiting child of one parent, oldest first: positions shift as the head starts. */
  ordered(parent: ThreadId): ThreadId[] {
    return this.store
      .statement("SELECT child_id FROM delegation_launch_queue WHERE parent_id=? ORDER BY seq")
      .all(parent)
      .map((row) => ThreadId.parse(row.child_id));
  }
  parents(): ThreadId[] {
    return this.store
      .statement("SELECT DISTINCT parent_id FROM delegation_launch_queue ORDER BY parent_id")
      .all()
      .map((row) => ThreadId.parse(row.parent_id));
  }
}
