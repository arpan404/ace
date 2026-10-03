import type { DatabaseSync } from "node:sqlite";
import { Run, RunCheckpoints, type EventPayload, type Thread, type ThreadId } from "@ace/protocol";
/** Stable ordinals are allocated once, independently of the transcript window. */
export function migrateRunClient(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS client_run_index(thread_id TEXT NOT NULL,run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(thread_id,run_id),UNIQUE(thread_id,ordinal));
    CREATE TABLE IF NOT EXISTS client_run_sequence(thread_id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS client_run_migration(id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS client_checkpoint_start(thread_id TEXT PRIMARY KEY,command_id TEXT NOT NULL,checkpoints TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS client_checkpoint_due(thread_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(thread_id,run_id));`);
  if (db.prepare("SELECT id FROM client_run_migration WHERE id=1").get()) return;
  const rows = db.prepare(
    "SELECT e.thread_id,e.id,e.value FROM view_entities e JOIN threads t ON t.id=e.thread_id WHERE e.collection='runs' AND json_extract(e.value,'$.agentId')=t.root_agent_id ORDER BY e.thread_id,json_extract(e.value,'$.startedAt'),e.id",
  );
  for (const row of rows.iterate()) {
    const run = Run.parse(JSON.parse(String(row.value)));
    const ordinal = allocate(db, run.threadId, run.id);
    db.prepare(
      "UPDATE view_entities SET value=? WHERE thread_id=? AND collection='runs' AND id=?",
    ).run(JSON.stringify({ ...run, ordinal }), run.threadId, run.id);
  }
  db.exec("INSERT INTO client_run_migration VALUES (1)");
}
function allocate(db: DatabaseSync, thread: string, run: string): number {
  const found = db
    .prepare("SELECT ordinal FROM client_run_index WHERE thread_id=? AND run_id=?")
    .get(thread, run);
  if (found) return Number(found.ordinal);
  const value = db
    .prepare(
      "INSERT INTO client_run_sequence VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET ordinal=ordinal+1 RETURNING ordinal",
    )
    .get(thread)?.ordinal;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("Run sequence exhausted");
  db.prepare("INSERT INTO client_run_index VALUES (?,?,?)").run(thread, run, value);
  return value;
}
export function prepareRunClient(
  db: DatabaseSync,
  thread: Thread,
  payload: EventPayload,
): EventPayload {
  if (payload.type !== "run.started" || payload.run.agentId !== thread.rootAgentId) return payload;
  const run = { ...payload.run, ordinal: allocate(db, thread.id, payload.run.id) };
  if (payload.run.agentId === thread.rootAgentId) {
    const start = db
      .prepare("SELECT checkpoints FROM client_checkpoint_start WHERE thread_id=?")
      .get(thread.id);
    if (start) {
      run.checkpoints = RunCheckpoints.parse(JSON.parse(String(start.checkpoints)));
      db.prepare("DELETE FROM client_checkpoint_start WHERE thread_id=?").run(thread.id);
    } else run.checkpoints = { state: "unavailable", error: "no_turn_boundary" };
  }
  return { type: "run.started", run };
}
export function listClientRuns(db: DatabaseSync, thread: ThreadId, before: number, limit: number) {
  const total = Number(
    db.prepare("SELECT ordinal FROM client_run_sequence WHERE thread_id=?").get(thread)?.ordinal ??
      0,
  );
  const rows = db
    .prepare(
      "SELECT e.value,r.ordinal FROM client_run_index r JOIN view_entities e ON e.thread_id=r.thread_id AND e.id=r.run_id AND e.collection='runs' WHERE r.thread_id=? AND r.ordinal<? ORDER BY r.ordinal DESC LIMIT ?",
    )
    .all(thread, before, limit + 1);
  const runs = rows
    .slice(0, limit)
    .map((row) => Run.parse({ ...Run.parse(JSON.parse(String(row.value))), ordinal: row.ordinal }));
  const last = runs.at(-1)?.ordinal;
  return { runs, total, ...(rows.length > limit && last ? { nextBefore: last } : {}) };
}
