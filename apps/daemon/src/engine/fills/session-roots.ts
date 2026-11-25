import type { DatabaseSync } from "node:sqlite";
import { ThreadId } from "@ace/protocol";
import type { Store } from "../../store.ts";
import { canonicalRoot } from "../../workspace-reservations.ts";
import { DurableFill, fillBatch } from "../open-fills.ts";

/**
 * Rewrites `engine_sessions.cwd` rows written before paths were canonical, so a session and the
 * workspace reservations that fence it name the same root. A reader that compares roots
 * canonicalizes what it finds until this reaches that row (`WorkspaceReservations.owners`), so a
 * change made before the fill arrives still fences the right threads.
 */
export class SessionRootsFill extends DurableFill {
  constructor(store: Store) {
    super(store, "session-roots");
  }
  protected page(db: DatabaseSync, cursor: string | undefined) {
    const rows = db
      .prepare(
        "SELECT rowid AS seq,thread_id,cwd FROM engine_sessions WHERE rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(Number(cursor ?? 0), fillBatch);
    const update = db.prepare("UPDATE engine_sessions SET cwd=? WHERE thread_id=?");
    for (const row of rows) {
      const path = String(row.cwd);
      const root = canonicalRoot(path);
      if (root !== path) update.run(root, ThreadId.parse(String(row.thread_id)));
    }
    return {
      next: rows.length ? String(rows[rows.length - 1]?.seq) : cursor,
      done: rows.length < fillBatch,
    };
  }
}
