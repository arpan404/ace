import type { ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

/** The journal fences admission before any destructive I/O and survives daemon death. */
export function initializeThreadCleanup(store: Store): void {
  store.atomic((db) =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS thread_cleanup (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id), command TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_cleanup_members (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id), owner TEXT NOT NULL REFERENCES thread_cleanup(thread_id)
    );
    CREATE INDEX IF NOT EXISTS thread_cleanup_owner ON thread_cleanup_members(owner);
    CREATE INDEX IF NOT EXISTS thread_liveness_candidates ON threads(id)
      WHERE json_extract(client,'$.deletedAt') IS NULL AND json_extract(status,'$.state') NOT IN ('new','done','failed');
  `),
  );
}

export function threadCleaning(store: Store, id: ThreadId): boolean {
  return Boolean(store.statement("SELECT 1 FROM thread_cleanup_members WHERE thread_id=?").get(id));
}
