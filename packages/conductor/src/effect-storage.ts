import { createHash } from "node:crypto";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { Key } from "./schema.ts";

export function migrateEffects(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(conductor_outbox)").all();
  if (!columns.some((column) => column.name === "retry_at"))
    db.exec(
      "ALTER TABLE conductor_outbox ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0; ALTER TABLE conductor_outbox ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;",
    );
  db.exec(
    "CREATE TABLE IF NOT EXISTS conductor_cleanup (run TEXT PRIMARY KEY REFERENCES conductor_runs(id) ON DELETE CASCADE)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS conductor_activity ON conductor_runs(COALESCE(json_extract(payload,'$.updatedAt'),0) DESC,COALESCE(json_extract(payload,'$.startedAt'),0) DESC,id)",
  );
  let after = "";
  for (;;) {
    const rows = db
      .prepare(
        "SELECT id FROM conductor_runs WHERE id>? AND json_extract(payload,'$.phase') IN ('done','cancelled') ORDER BY id LIMIT 128",
      )
      .all(after);
    if (!rows.length) break;
    for (const row of rows) {
      after = Key.parse(row.id);
      queueCleanup(db, after);
    }
  }
}

/** The marker and cleanup intent commit with terminal state, and survive acknowledgement. */
export function queueCleanup(db: DatabaseSync, run: string): void {
  const created = db.prepare("INSERT OR IGNORE INTO conductor_cleanup VALUES (?)").run(run);
  if (!created.changes) return;
  const id = `cleanup.${createHash("sha256").update(run).digest("hex")}`;
  db.prepare("INSERT INTO conductor_outbox(run,id,payload) VALUES (?,?,?)").run(
    run,
    id,
    JSON.stringify({ type: "cleanup", id, runId: run }),
  );
}
