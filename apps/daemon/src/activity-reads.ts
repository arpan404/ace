import { ActivityReadCursor, type ActivityReadsChanged } from "@ace/protocol";
import { applyActivityReads, type ActivityReadChange } from "@ace/projection/activity-reads";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { z } from "zod";
import type { Store } from "./store.ts";

export type { ActivityReadChange };
const Row = z.object({ cursor: z.string() });

/**
 * The Activity read cursor (protocol `activity.reads`): one per host, in the event store, so
 * read marks survive restarts and reach every device. Changes merge into the stored cursor in
 * one transaction, so two devices marking at once both land. Subscribers hear each change.
 */
export class ActivityReads {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly listeners = new Set<(change: ActivityReadsChanged) => void>();
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS activity_read_cursor (
        id INTEGER PRIMARY KEY CHECK(id = 1), cursor TEXT NOT NULL
      )`),
    );
  }

  /** The cursor; the first read starts it now, so what happened before counts as read. */
  get(): ActivityReadCursor {
    return this.store.atomic((db) => this.read(db));
  }

  mark(change: ActivityReadChange): ActivityReadCursor {
    const cursor = this.store.atomic((db) => {
      const next = applyActivityReads(this.read(db), change);
      db.prepare("UPDATE activity_read_cursor SET cursor = ? WHERE id = 1").run(
        JSON.stringify(next),
      );
      return next;
    });
    for (const listener of this.listeners) {
      try {
        listener({ type: "activity.reads.changed", cursor });
      } catch {
        // One socket's failure never stops the others hearing it.
      }
    }
    return cursor;
  }

  private read(db: DatabaseSync): ActivityReadCursor {
    const row = Row.safeParse(
      db.prepare("SELECT cursor FROM activity_read_cursor WHERE id = 1").get(),
    );
    const stored = row.success ? ActivityReadCursor.safeParse(parse(row.data.cursor)) : undefined;
    if (stored?.success) return stored.data;
    const fresh: ActivityReadCursor = { before: this.now(), read: [], unread: [], revision: 0 };
    db.prepare("INSERT OR REPLACE INTO activity_read_cursor (id, cursor) VALUES (1, ?)").run(
      JSON.stringify(fresh),
    );
    return fresh;
  }

  subscribe(listener: (change: ActivityReadsChanged) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
