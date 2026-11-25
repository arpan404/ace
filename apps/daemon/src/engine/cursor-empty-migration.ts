import { cursorDefaultInstanceId, cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { ThreadId } from "@ace/protocol";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store.ts";
import { DurableFill, fillBatch } from "./open-fills.ts";

/**
 * Only unused CLI threads can continue directly; native ACP identities never become SDK IDs.
 * The same check, for one thread, so a Cursor thread opened before the fill reaches it gets the
 * backend it would have had, and so nothing reads a thread the pass has not visited.
 */
export function migrateEmptyCursorThread(
  db: DatabaseSync,
  store: Store,
  threadId: ThreadId,
): boolean {
  const row = db
    .prepare(`SELECT t.updated_at,s.instance_id FROM threads t
      JOIN engine_sessions s ON s.thread_id=t.id
      JOIN thread_state snapshot ON snapshot.thread_id=t.id
      WHERE t.id=? AND t.provider='cursor'
      AND COALESCE(json_extract(t.provider_metadata,'$.backend'),'acp')<>'cursor-sdk'
      AND s.native_session_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM items WHERE thread_id=t.id)
      AND json_extract(snapshot.state,'$.hasRun')=0
      AND NOT EXISTS (SELECT 1 FROM intents WHERE thread_id=t.id AND status IN ('pending','queued','running'))`)
    .get(threadId);
  if (!row) return false;
  const instanceId =
    row.instance_id == null ? cursorDefaultInstanceId : cursorInstanceId(String(row.instance_id));
  db.prepare("UPDATE engine_sessions SET backend='cursor-sdk',instance_id=? WHERE thread_id=?").run(
    instanceId ?? cursorDefaultInstanceId,
    threadId,
  );
  store.appendEvents(
    threadId,
    [{ type: "thread.updated", backend: "cursor-sdk" }],
    Number(row.updated_at),
  );
  return true;
}

/** Every Cursor thread the migration applies to, 256 a step, paged by `threads.rowid`. */
export class CursorEmptyFill extends DurableFill {
  private engineStore: Store;
  constructor(store: Store) {
    super(store, "cursor-empty");
    this.engineStore = store;
  }
  protected page(db: DatabaseSync, cursor: string | undefined) {
    const rows = db
      .prepare("SELECT rowid AS seq,id FROM threads WHERE rowid>? ORDER BY rowid LIMIT ?")
      .all(Number(cursor ?? 0), fillBatch);
    for (const row of rows)
      migrateEmptyCursorThread(db, this.engineStore, ThreadId.parse(String(row.id)));
    return {
      next: rows.length ? String(rows[rows.length - 1]?.seq) : cursor,
      done: rows.length < fillBatch,
    };
  }
}
