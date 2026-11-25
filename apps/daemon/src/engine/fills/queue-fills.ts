import type { DatabaseSync } from "node:sqlite";
import { Command, QueueSnapshot } from "@ace/protocol";
import type { Store } from "../../store.ts";
import { DurableFill, fillBatch } from "../open-fills.ts";
import type { QueueStore } from "../queue-store.ts";

/**
 * One `engine_queue` row per thread with engine state. A missing row is a valid read (the
 * defaults), so this pass only adds rows and every reader is right without it. Paged by
 * `thread_state.rowid`, which every supported home has.
 */
export class QueueRowsFill extends DurableFill {
  constructor(store: Store) {
    super(store, "queue-rows");
  }
  protected page(db: DatabaseSync, cursor: string | undefined) {
    const rows = db
      .prepare(
        "SELECT rowid AS seq,thread_id FROM thread_state WHERE rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(Number(cursor ?? 0), fillBatch);
    const ensure = db.prepare("INSERT OR IGNORE INTO engine_queue(thread_id) VALUES (?)");
    for (const row of rows) ensure.run(String(row.thread_id));
    return {
      next: rows.length ? String(rows[rows.length - 1]?.seq) : cursor,
      done: rows.length < fillBatch,
    };
  }
}

/**
 * The attachments each live intent needs retained. Rows written at enqueue and edit are already
 * current; this repairs intents that predate those writers, and `QueueStore.retains` reads the
 * live intents' own payloads until it completes.
 */
export class QueueAttachmentsFill extends DurableFill {
  private queue: QueueStore;
  constructor(store: Store, queue: QueueStore) {
    super(store, "queue-attachments");
    this.queue = queue;
  }
  protected page(db: DatabaseSync, cursor: string | undefined) {
    // Keyset over the primary key with no filter, so a step visits a bounded 256 rows whatever
    // the predicate leaves; only a matching intent's payload is parsed.
    const rows = db
      .prepare(
        `SELECT id,thread_id,kind,status,awaiting,uncertain,payload FROM intents
        WHERE id>? ORDER BY id LIMIT ?`,
      )
      .all(Number(cursor ?? 0), fillBatch);
    for (const row of rows) {
      const live = row.status === "pending" || row.status === "queued" || row.status === "running";
      if (
        (row.kind !== "thread.create" && row.kind !== "thread.send") ||
        !(live || row.awaiting === 1 || row.uncertain === 1)
      )
        continue;
      this.queue.track(
        Number(row.id),
        QueueSnapshot.shape.threadId.parse(row.thread_id),
        Command.parse(JSON.parse(String(row.payload))),
      );
    }
    return {
      next: rows.length ? String(rows[rows.length - 1]?.id) : cursor,
      done: rows.length < fillBatch,
    };
  }
}
