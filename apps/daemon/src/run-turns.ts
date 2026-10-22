import type { DatabaseSync } from "node:sqlite";
import type { EventPayload, Run, Thread } from "@ace/protocol";
import { startedRunTurn, startsTurn } from "@ace/projection";

/**
 * Turn numbers for root runs (ADR 0062): one turn is an ask and every root run after it until
 * the next ask. Runs recorded before this table existed keep their run ordinal as their turn,
 * and the thread's turns continue from its last run ordinal, so nothing is rewritten.
 */
export function migrateRunTurns(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS client_turn_sequence(thread_id TEXT PRIMARY KEY,turn INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS client_run_turn(thread_id TEXT NOT NULL,run_id TEXT NOT NULL,turn INTEGER NOT NULL,PRIMARY KEY(thread_id,run_id));
    CREATE TABLE IF NOT EXISTS client_turn_asks(thread_id TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(thread_id,item_id));
    CREATE INDEX IF NOT EXISTS client_run_turn_number ON client_run_turn(thread_id,turn);`);
}

/**
 * Asks waiting for a run: root messages that open a turn (`startsTurn`) which no started run has
 * taken yet. A message bound to a run that already started (a steer into the running turn)
 * joins that run's turn instead; a deleted message (a queued send withdrawn) asks nothing.
 */
export function trackTurnAsk(db: DatabaseSync, thread: Thread, payload: EventPayload): void {
  if (payload.type === "item.deleted") {
    forget(db, thread.id, payload.itemId);
    return;
  }
  if (payload.type !== "item.created" && payload.type !== "item.updated") return;
  const item = payload.item;
  if (item.agentId !== thread.rootAgentId || !startsTurn(item)) return;
  const started =
    item.runId !== undefined &&
    db
      .prepare("SELECT 1 FROM client_run_index WHERE thread_id=? AND run_id=?")
      .get(thread.id, item.runId);
  if (started) forget(db, thread.id, item.id);
  else if (payload.type === "item.created")
    db.prepare("INSERT OR IGNORE INTO client_turn_asks VALUES (?,?)").run(thread.id, item.id);
}

function forget(db: DatabaseSync, thread: string, item: string): void {
  db.prepare("DELETE FROM client_turn_asks WHERE thread_id=? AND item_id=?").run(thread, item);
}

/**
 * A root run's turn, allocated once and before its run ordinal (`runSequence` is the thread's
 * run sequence before this run). A waiting ask, or a trigger saying the run was asked for,
 * opens the next turn; the run consumes every waiting ask.
 */
export function allocateRunTurn(
  db: DatabaseSync,
  thread: string,
  run: Pick<Run, "id" | "trigger">,
  runSequence: number,
): number {
  const known = db
    .prepare("SELECT turn FROM client_run_turn WHERE thread_id=? AND run_id=?")
    .get(thread, run.id);
  if (known) return Number(known.turn);
  const legacy = db
    .prepare("SELECT ordinal FROM client_run_index WHERE thread_id=? AND run_id=?")
    .get(thread, run.id);
  if (legacy) return Number(legacy.ordinal);
  const current = db.prepare("SELECT turn FROM client_turn_sequence WHERE thread_id=?").get(thread);
  const asked = db.prepare("SELECT 1 FROM client_turn_asks WHERE thread_id=? LIMIT 1").get(thread);
  const turn = startedRunTurn({
    current: current ? Number(current.turn) : undefined,
    legacyBase: runSequence,
    asked: asked !== undefined,
    trigger: run.trigger,
  });
  db.prepare(
    "INSERT INTO client_turn_sequence VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET turn=excluded.turn",
  ).run(thread, turn);
  db.prepare("INSERT INTO client_run_turn VALUES (?,?,?)").run(thread, run.id, turn);
  db.prepare("DELETE FROM client_turn_asks WHERE thread_id=?").run(thread);
  return turn;
}
