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
/** Where one thread's bounded rebuild stands: clearing its old blockers, then its agent records. */
type Rebuild = { phase: "clear" } | { phase: "agents"; key: string };

/**
 * Stores only blockers. Delta handling never enumerates historical agents.
 *
 * Blockers decide `agentsReady`, so a thread's blockers are trusted only once its rebuild from
 * the stored records has committed this boot (ADR 0170): open no longer rebuilds every thread's
 * blockers, a bounded fill does, and until then the thread reads as not ready, never as done.
 */
export class TransitionReadiness implements OpenFill {
  readonly name = "readiness";
  /** Set by the repository so a requested rebuild restarts the fill driver. */
  gained?: () => void;
  /** Told when a thread's rebuild commits, so what waited on it runs now. */
  onRebuilt?: (id: ThreadId) => void;
  private store: Store;
  private put: StatementSync;
  private remove: StatementSync;
  private find: StatementSync;
  private keys: StatementSync;
  private now: () => number;
  /** Threads whose blockers were rebuilt from stored records and committed this boot. */
  private rebuiltThreads = new Set<ThreadId>();
  private rebuilding = new Map<ThreadId, Rebuild>();
  /** Threads the pass will rebuild; asking moves one to the front. */
  private queued: ThreadId[] = [];
  private waiters = new Map<ThreadId, (() => void)[]>();
  /** The last thread each discovery source read, for its keyset page. */
  private agentCursor = "";
  private blockerCursor = "";
  private discovered = false;
  /** The pass has started: until it reaches a thread, that thread's blockers are not trusted. */
  private warming = false;
  /** A step kept failing: readers stop waiting on it, for the threads it is not mid-rebuild on. */
  private fallback = false;
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_transition_blockers (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        agent_key TEXT NOT NULL, PRIMARY KEY(thread_id, agent_key)
      )`),
    );
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
    if (events.some((event) => event.type === "thread.created")) this.created(state.threadId);
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
    return this.rebuilt(state.threadId) && !this.find.get(state.threadId);
  }
  /** Whether the root is between turns and free to take a person's next message. */
  acceptsPersonInput(state: ThreadState): boolean {
    // Not rebuilt reads as not free: the message queues, as it does for a busy thread.
    return this.rebuilt(state.threadId) && acceptsPersonInput(state, this.now());
  }
  /** A thread whose state was just created: it has no older records, so its blockers are current. */
  private created(id: ThreadId): void {
    this.rebuilding.delete(id);
    this.rebuiltThreads.add(id);
    this.resolve(id);
  }
  /** Whether the thread's blockers were rebuilt this boot, or it has none to rebuild. */
  rebuilt(id: ThreadId): boolean {
    // No pass runs in this process (a repository opened outside an engine): the stored blockers
    // are what there is, and nothing waits on a rebuild that will never come.
    if (!this.warming) return true;
    if (this.rebuiltThreads.has(id)) return true;
    // A failing pass still leaves an untouched thread's blockers as the last boot wrote them,
    // which is exactly what main's read trusted. One it was part-way through is not trusted.
    if (this.fallback && !this.rebuilding.has(id)) return true;
    return (
      !this.store
        .statement(
          "SELECT 1 FROM engine_state_records WHERE thread_id=? AND section='agents' LIMIT 1",
        )
        .get(id) && !this.find.get(id)
    );
  }
  /**
   * Rebuild this thread next, before anything the pass had queued, and say when that commits.
   * A thread already rebuilt resolves at once.
   */
  whenRebuilt(id: ThreadId): Promise<void> {
    if (this.rebuilt(id)) return Promise.resolve();
    const pending = new Promise<void>((resolve) => {
      const waiting = this.waiters.get(id) ?? [];
      waiting.push(resolve);
      this.waiters.set(id, waiting);
    });
    this.request(id);
    return pending;
  }
  /** Move the thread's rebuild to the front of the pass's queue. */
  request(id: ThreadId): void {
    if (this.rebuilt(id)) return;
    this.queued = [id, ...this.queued.filter((queued) => queued !== id)];
    this.gained?.();
  }
  start(): void {
    this.warming = true;
  }
  step(): boolean {
    this.warming = true;
    // Peek: a thread stays at the front until its rebuild commits, so a rolled-back step repeats.
    const id = this.queued[0];
    if (id !== undefined) return this.rebuildStep(id);
    if (!this.discovered) {
      const page = this.discover();
      this.queued = page.threads;
      this.discovered = page.done;
      return page.threads.length > 0;
    }
    return false;
  }
  /** A step kept failing: nothing waits on it any more, and no partial blocker set is trusted. */
  failed(): void {
    this.fallback = true;
    for (const waiting of this.waiters.values()) for (const resolve of waiting) resolve();
    this.waiters.clear();
  }
  complete(): boolean {
    return this.discovered && !this.queued.length && !this.rebuilding.size;
  }

  /** One bounded step of one thread's rebuild, committed or not. */
  private rebuildStep(id: ThreadId): boolean {
    // A thread rebuilt this boot (created or settled since it was queued) is never cleared again:
    // clearing it would drop its current blockers while its rebuilt flag still said trusted.
    if (this.rebuiltThreads.has(id)) {
      this.queued = this.queued.filter((queued) => queued !== id);
      return true;
    }
    const before = this.rebuilding.get(id) ?? ({ phase: "clear" } as Rebuild);
    let next = before;
    let finished = false;
    this.store.atomic(
      () => {
        if (before.phase === "clear") {
          const cleared = Number(
            this.store
              .statement(
                `DELETE FROM engine_transition_blockers
                WHERE rowid IN (SELECT rowid FROM engine_transition_blockers WHERE thread_id=? LIMIT ?)`,
              )
              .run(id, fillBatch).changes,
          );
          next = cleared >= fillBatch ? { phase: "clear" } : { phase: "agents", key: "" };
          return;
        }
        const rows = this.store
          .statement(
            `SELECT key,value FROM engine_state_records
            WHERE thread_id=? AND section='agents' AND key>? ORDER BY key LIMIT ?`,
          )
          .all(id, before.phase === "agents" ? before.key : "", fillBatch);
        for (const row of rows) {
          const record = recordSchemas.agents.parse(JSON.parse(String(row.value)));
          if (!agentReady(record, this.now())) this.put.run(id, String(row.key));
        }
        finished = rows.length < fillBatch;
        next = { phase: "agents", key: String(rows[rows.length - 1]?.key ?? "") };
      },
      {
        committed: () => {
          this.fallback = false;
          if (finished) this.settle(id);
          else this.rebuilding.set(id, next);
        },
        rolledBack: () => {},
      },
    );
    return true;
  }
  private settle(id: ThreadId): void {
    this.rebuilding.delete(id);
    this.rebuiltThreads.add(id);
    this.queued = this.queued.filter((queued) => queued !== id);
    this.resolve(id);
    this.onRebuilt?.(id);
  }
  /** The engine is closing: nothing waits for a rebuild that will not finish. */
  stop(): void {
    for (const waiting of this.waiters.values()) for (const resolve of waiting) resolve();
    this.waiters.clear();
  }
  private resolve(id: ThreadId): void {
    const waiting = this.waiters.get(id);
    if (!waiting) return;
    this.waiters.delete(id);
    for (const resolve of waiting) resolve();
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
    const threads = [...new Set([...agents.rows, ...blockers.rows])]
      .filter((id) => !this.rebuiltThreads.has(id))
      .toSorted();
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
