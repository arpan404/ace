import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AgentRecord, ThreadState } from "@ace/core";
import type { EventPayload } from "@ace/protocol";
import { recordSchemas } from "./snapshot.ts";
import { acceptsPersonInput } from "./input-readiness.ts";
/**
 * A root that has never started a run is a thread awaiting its first input. Core materializes
 * it as "starting" when any event arrives before a turn; that is not work in progress.
 */
function neverStarted(record: AgentRecord): boolean {
  return (
    record.agent.origin === "root" &&
    record.agent.status.state === "starting" &&
    record.lastRun === undefined
  );
}
function agentReady(record: AgentRecord, now: number): boolean {
  return (
    !record.activeRun &&
    (record.wakeUntil === undefined || record.wakeUntil <= now) &&
    record.disconnectedAt === undefined &&
    (neverStarted(record) ||
      ["idle", "interrupted", "failed"].includes(record.agent.status.state) ||
      (record.agent.status.state === "blocked" && record.agent.status.on === "rate_limit") ||
      (record.agent.status.state === "working" &&
        record.agent.status.activity === "starting_turn" &&
        record.wakeUntil !== undefined &&
        record.wakeUntil <= now))
  );
}
/** Stores only blockers. Delta handling never enumerates historical agents. */
export class TransitionReadiness {
  private put: StatementSync;
  private remove: StatementSync;
  private find: StatementSync;
  private keys: StatementSync;
  private now: () => number;
  constructor(db: DatabaseSync, now: () => number) {
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS engine_transition_blockers (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      agent_key TEXT NOT NULL, PRIMARY KEY(thread_id, agent_key)
    )`);
    this.put = db.prepare("INSERT OR IGNORE INTO engine_transition_blockers VALUES (?, ?)");
    this.remove = db.prepare(
      "DELETE FROM engine_transition_blockers WHERE thread_id=? AND agent_key=?",
    );
    this.find = db.prepare(
      "SELECT agent_key FROM engine_transition_blockers WHERE thread_id=? LIMIT 1",
    );
    this.keys = db.prepare("SELECT agent_key FROM engine_transition_blockers WHERE thread_id=?");
    db.exec("DELETE FROM engine_transition_blockers");
    for (const row of db
      .prepare("SELECT thread_id,key,value FROM engine_state_records WHERE section='agents'")
      .iterate()) {
      const record = recordSchemas.agents.parse(JSON.parse(String(row.value)));
      if (!agentReady(record, this.now())) this.put.run(String(row.thread_id), String(row.key));
    }
  }
  private update(state: ThreadState, key: string): void {
    const record = state.agents[key];
    if (!record || agentReady(record, this.now())) this.remove.run(state.threadId, key);
    else this.put.run(state.threadId, key);
  }
  capture(state: ThreadState, events: readonly EventPayload[]): void {
    const changed = new Set<string>();
    for (const event of events) {
      const id =
        event.type === "agent.created"
          ? event.agent.id
          : event.type === "agent.status" || event.type === "agent.updated"
            ? event.agentId
            : event.type === "run.started"
              ? event.run.agentId
              : event.type === "run.ended"
                ? state.runs[event.runId]?.agentId
                : undefined;
      const key = id ? state.indexes.agentKeysById[id] : undefined;
      if (key) changed.add(key);
    }
    for (const key of changed) this.update(state, key);
  }
  refreshBlocked(state: ThreadState): void {
    for (const row of this.keys.iterate(state.threadId)) this.update(state, String(row.agent_key));
  }
  agentsReady(state: ThreadState): boolean {
    return !this.find.get(state.threadId);
  }
  /** Reads only this thread's blockers, so the check never walks historical agents. */
  acceptsPersonInput(state: ThreadState): boolean {
    const blockers = Array.from(this.keys.iterate(state.threadId), (row) => String(row.agent_key));
    return acceptsPersonInput(state, blockers, this.now());
  }
}
