import type { StatementSync } from "node:sqlite";
import { acceptsPersonInput, type AgentRecord, type ThreadState } from "@ace/core";
import { ThreadId, type EventPayload } from "@ace/protocol";
import type { Store } from "../store.ts";
import { fillBatch, type OpenFill } from "./open-fills.ts";
import { recordSchemas } from "./snapshot.ts";
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
export function agentReady(record: AgentRecord, now: number): boolean {
  if (record.externalStatus) return true;
  return (
    !record.activeRun &&
    (record.wakeUntil === undefined || record.wakeUntil <= now) &&
    record.disconnectedAt === undefined &&
    (neverStarted(record) ||
      ["idle", "interrupted", "failed"].includes(record.agent.status.state) ||
      (record.agent.status.state === "blocked" &&
        ["rate_limit", "background_task", "subagents"].includes(record.agent.status.on)) ||
      (record.agent.status.state === "working" &&
        record.agent.status.activity === "starting_turn" &&
        record.wakeUntil !== undefined &&
        record.wakeUntil <= now))
  );
}
/** The agent a changed fact belongs to, when the fact names one this state knows. */
function changedAgent(event: EventPayload, state: ThreadState): string | undefined {
  return event.type === "agent.created"
    ? event.agent.id
    : event.type === "agent.status" || event.type === "agent.updated"
      ? event.agentId
      : event.type === "run.started"
        ? event.run.agentId
        : event.type === "run.ended"
          ? state.runs[event.runId]?.agentId
          : undefined;
}

/**
 * Stores only blockers. Delta handling never enumerates historical agents.
 *
 * A thread's blockers are rebuilt from its own stored agent rows the first time this boot needs
 * them (a read, an admission, delivery), inside that caller's transaction, and a mark written
 * with them says so. That work is proportional to one thread's agents, not to history (ADR
 * 0170), so it is safe where it happens. The background fill only pre-warms: it walks every
 * thread in keyset pages and rebuilds the unmarked ones one step at a time, and correctness
 * never depends on it finishing.
 */
export class TransitionReadiness implements OpenFill {
  readonly name = "readiness";
  private store: Store;
  private now: () => number;
  /** This process's boot; a mark from an earlier boot is not a rebuild. */
  private boot: string;
  private put: StatementSync;
  private remove: StatementSync;
  private find: StatementSync;
  private keys: StatementSync;
  /** Threads the pre-warm has still to rebuild; a page's unmarked ids. */
  private queued: ThreadId[] = [];
  private agentCursor = "";
  private blockerCursor = "";
  private discovered = false;
  constructor(store: Store, now: () => number, boot: string) {
    this.store = store;
    this.now = now;
    this.boot = boot;
    store.atomic((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS engine_transition_blockers (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        agent_key TEXT NOT NULL, PRIMARY KEY(thread_id, agent_key)
      );
      CREATE TABLE IF NOT EXISTS engine_readiness_rebuilt (
        thread_id TEXT PRIMARY KEY, boot TEXT NOT NULL
      )`);
    });
    const statement = (sql: string) => store.statement(sql);
    this.put = statement("INSERT OR IGNORE INTO engine_transition_blockers VALUES (?, ?)");
    this.remove = statement(
      "DELETE FROM engine_transition_blockers WHERE thread_id=? AND agent_key=?",
    );
    this.find = statement(
      "SELECT agent_key FROM engine_transition_blockers WHERE thread_id=? LIMIT 1",
    );
    this.keys = statement("SELECT agent_key FROM engine_transition_blockers WHERE thread_id=?");
  }
  private update(state: ThreadState, key: string): void {
    const record = state.agents[key];
    if (!record || agentReady(record, this.now())) this.remove.run(state.threadId, key);
    else this.put.run(state.threadId, key);
  }
  capture(state: ThreadState, events: readonly EventPayload[]): void {
    if (events.some((event) => event.type === "thread.created")) this.markCreated(state.threadId);
    const changed = new Set<string>();
    for (const event of events) {
      const id = changedAgent(event, state);
      const key = id ? state.indexes.agentKeysById[id] : undefined;
      if (key) changed.add(key);
    }
    for (const key of changed) this.update(state, key);
  }
  refreshBlocked(state: ThreadState): void {
    for (const row of this.keys.iterate(state.threadId)) this.update(state, String(row.agent_key));
  }
  agentsReady(state: ThreadState): boolean {
    this.ensureRebuilt(state.threadId);
    return !this.find.get(state.threadId);
  }
  /** Whether the root is between turns and free to take a person's next message. */
  acceptsPersonInput(state: ThreadState): boolean {
    this.ensureRebuilt(state.threadId);
    return acceptsPersonInput(state, this.now());
  }
  /**
   * Rebuild this thread's blockers from its stored agent rows unless this boot already did. Every
   * reader and every admission calls this before it answers, so nothing ever trusts a half-
   * rebuilt or last-boot set.
   */
  ensureRebuilt(id: ThreadId): void {
    if (this.rebuilt(id)) return;
    this.rebuildNow(id);
  }
  /** Whether this boot rebuilt the thread's blockers (the mark is durable and per boot). */
  rebuilt(id: ThreadId): boolean {
    return Boolean(
      this.store
        .statement("SELECT 1 FROM engine_readiness_rebuilt WHERE thread_id=? AND boot=?")
        .get(id, this.boot),
    );
  }
  /**
   * Clear the thread's blockers and write the ones its own agent rows decide, with the mark, in
   * one transaction. They commit or roll back together, so a crash can never leave a half-
   * cleared set marked rebuilt.
   */
  private rebuildNow(id: ThreadId): void {
    this.store.atomic((db) => {
      db.prepare("DELETE FROM engine_transition_blockers WHERE thread_id=?").run(id);
      const rows = this.store
        .statement(
          "SELECT key,value FROM engine_state_records WHERE thread_id=? AND section='agents' ORDER BY key",
        )
        .all(id);
      const now = this.now();
      for (const row of rows) {
        const record = recordSchemas.agents.parse(JSON.parse(String(row.value)));
        if (!agentReady(record, now)) this.put.run(id, String(row.key));
      }
      db.prepare(
        "INSERT INTO engine_readiness_rebuilt(thread_id,boot) VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET boot=excluded.boot",
      ).run(id, this.boot);
    });
  }
  /**
   * A thread created this boot has no older records, so its (empty) blocker set is right. The
   * mark is written in the creating transaction: a rolled-back creation leaves no mark either.
   */
  private markCreated(id: ThreadId): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO engine_readiness_rebuilt(thread_id,boot) VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET boot=excluded.boot",
        )
        .run(id, this.boot),
    );
  }
  /**
   * One pre-warm step: rebuild one unmarked thread, or take the next keyset page of candidate
   * threads. A page advances the cursor even when everything on it was already rebuilt, and says
   * so, so the driver always moves on to the next page.
   */
  step(): boolean {
    const next = this.queued.shift();
    if (next !== undefined) {
      if (!this.rebuilt(next)) this.rebuildNow(next);
      return true;
    }
    if (this.discovered) return false;
    const page = this.discover();
    this.queued = page.threads.filter((id) => !this.rebuilt(id));
    this.discovered = page.done;
    return true;
  }
  complete(): boolean {
    return this.discovered && !this.queued.length;
  }
  /**
   * Up to a page of threads, merged from the agent records and the existing blockers so a thread
   * with blockers and no agent rows is visited too. Each source is a plain keyset page over its
   * `thread_id` prefix, so a step visits a bounded number of rows however many records a thread
   * has: ordering by that prefix lets the scan stop at the page's last row.
   */
  private discover(): { threads: ThreadId[]; done: boolean } {
    // Half a page from each source: one step never reads more than a fill batch of rows.
    const half = Math.floor(fillBatch / 2);
    const agents = this.discoverSource(
      "SELECT thread_id FROM engine_state_records WHERE section='agents' AND thread_id>? ORDER BY thread_id LIMIT ?",
      "agentCursor",
      half,
    );
    const blockers = this.discoverSource(
      "SELECT thread_id FROM engine_transition_blockers WHERE thread_id>? ORDER BY thread_id LIMIT ?",
      "blockerCursor",
      half,
    );
    if (agents.rows.length)
      this.agentCursor = agents.rows[agents.rows.length - 1] ?? this.agentCursor;
    if (blockers.rows.length)
      this.blockerCursor = blockers.rows[blockers.rows.length - 1] ?? this.blockerCursor;
    const threads = [...new Set([...agents.rows, ...blockers.rows])].toSorted();
    return { threads, done: agents.short && blockers.short };
  }
  private discoverSource(sql: string, cursor: "agentCursor" | "blockerCursor", limit: number) {
    const rows = this.store
      .statement(sql)
      .all(this[cursor], limit)
      .map((row) => ThreadId.parse(row.thread_id));
    return { rows, short: rows.length < limit };
  }
}
