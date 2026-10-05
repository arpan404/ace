import { counterPolicy, accountSample, Counts } from "@ace/usage";
import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { DelegationRecord, ThreadId, type DelegationOutcome, type Event } from "@ace/protocol";
import type { Store } from "../store.ts";
import { hasStoppedAncestor } from "./ancestor-stop.ts";

export const DelegationReservation = z.object({
  record: DelegationRecord,
  accountId: z.string().max(128).optional(),
});
export type DelegationReservation = z.infer<typeof DelegationReservation>;
const treeRow = z.object({
  root_id: ThreadId,
  started_at: z.number(),
  children: z.number(),
  tokens: z.number(),
  cost: z.number(),
  cancelled: z.number(),
});
/** One writer on Store's transaction boundary; only indexed current rows enter memory. */
export class DelegationJournal {
  private store: Store;
  private capacity: number;
  private statements = new Map<string, StatementSync>();
  constructor(store: Store, capacity = 10000) {
    this.capacity = z.number().int().min(1).max(10000).parse(capacity);
    this.store = store;
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS delegation_trees (
        root_id TEXT PRIMARY KEY REFERENCES threads(id), started_at INTEGER NOT NULL,
        children INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS delegation_deadlines ON delegation_trees(cancelled,started_at) WHERE active>0;
      CREATE TABLE IF NOT EXISTS delegated_threads (
        child_id TEXT PRIMARY KEY REFERENCES threads(id), parent_id TEXT NOT NULL REFERENCES threads(id),
        root_id TEXT NOT NULL REFERENCES delegation_trees(root_id), request_id TEXT NOT NULL,
        record JSON NOT NULL, phase TEXT NOT NULL, result_pending INTEGER NOT NULL DEFAULT 0,
        UNIQUE(parent_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS delegated_parent ON delegated_threads(parent_id, phase);
      CREATE INDEX IF NOT EXISTS delegated_root ON delegated_threads(root_id, child_id);
      CREATE INDEX IF NOT EXISTS delegated_active ON delegated_threads(child_id) WHERE phase<>'settled';
      CREATE INDEX IF NOT EXISTS delegated_live_root ON delegated_threads(root_id,phase);
      CREATE TABLE IF NOT EXISTS delegation_capacity (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), receipts INTEGER NOT NULL, reservations INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO delegation_capacity(singleton,receipts) SELECT 1,COUNT(*) FROM delegated_threads;
      CREATE TRIGGER IF NOT EXISTS delegation_receipt_added AFTER INSERT ON delegated_threads BEGIN
        UPDATE delegation_capacity SET receipts=receipts+1 WHERE singleton=1;
      END;
      CREATE TRIGGER IF NOT EXISTS delegation_receipt_deleted AFTER DELETE ON delegated_threads BEGIN
        UPDATE delegation_capacity SET receipts=receipts-1 WHERE singleton=1;
      END;
      CREATE TABLE IF NOT EXISTS delegation_reservations (
        child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, root_id TEXT NOT NULL,
        request_id TEXT NOT NULL, reservation JSON NOT NULL, UNIQUE(parent_id,request_id)
      );
      CREATE INDEX IF NOT EXISTS delegation_reserved_parent ON delegation_reservations(parent_id);
      CREATE INDEX IF NOT EXISTS delegated_results ON delegated_threads(parent_id, result_pending, child_id);
      CREATE TABLE IF NOT EXISTS delegation_subtree_stops (thread_id TEXT PRIMARY KEY REFERENCES threads(id));
      CREATE TABLE IF NOT EXISTS delegation_wakes (
        parent_id TEXT PRIMARY KEY REFERENCES threads(id), due INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delegation_wake_due ON delegation_wakes(due,parent_id);
      CREATE TABLE IF NOT EXISTS delegation_usage (
        root_id TEXT NOT NULL, agent_id TEXT NOT NULL, counter_key TEXT NOT NULL,
        tokens INTEGER NOT NULL, cost REAL NOT NULL, counts JSON NOT NULL, PRIMARY KEY(root_id,agent_id,counter_key)
      );
      CREATE TABLE IF NOT EXISTS delegation_agent_runs (agent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_thread_metadata (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id), pr_url TEXT, snoozed_until INTEGER
      );
    `),
    );
    store.atomic((db) => {
      const columns = db.prepare("PRAGMA table_info(delegation_trees)").all();
      if (!columns.some((column) => column.name === "retry_at"))
        db.exec(
          "ALTER TABLE delegation_trees ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0; ALTER TABLE delegation_trees ADD COLUMN failures INTEGER NOT NULL DEFAULT 0",
        );
    });
  }
  private sql(query: string) {
    let statement = this.statements.get(query);
    if (!statement) {
      statement = this.store.atomic((db) => db.prepare(query));
      this.statements.set(query, statement);
    }
    return statement;
  }
  private decode(value: unknown) {
    return DelegationRecord.parse(JSON.parse(z.string().parse(value)));
  }
  get(child: string): DelegationRecord | undefined {
    const row = this.sql("SELECT record FROM delegated_threads WHERE child_id=?").get(child);
    return row ? this.decode(row.record) : undefined;
  }
  receipt(parent: string, request: string) {
    const row = this.sql(
      "SELECT record FROM delegated_threads WHERE parent_id=? AND request_id=?",
    ).get(parent, request);
    return row ? this.decode(row.record) : undefined;
  }
  tree(thread: ThreadId, now: number) {
    const edge = this.get(thread);
    const root = edge?.rootId ?? thread;
    this.sql("INSERT OR IGNORE INTO delegation_trees(root_id,started_at) VALUES (?,?)").run(
      root,
      now,
    );
    const row = treeRow.parse(this.sql("SELECT * FROM delegation_trees WHERE root_id=?").get(root));
    return {
      root,
      depth: edge?.depth ?? 0,
      startedAt: row.started_at,
      children: row.children,
      usage: { tokens: row.tokens, cost: row.cost },
      cancelled: row.cancelled === 1,
    };
  }
  concurrent(parent: ThreadId) {
    return Number(
      this.sql(`SELECT
      (SELECT COUNT(*) FROM delegated_threads WHERE parent_id=? AND phase<>'settled') +
      (SELECT COUNT(*) FROM delegation_reservations WHERE parent_id=?) AS n`).get(parent, parent)
        ?.n,
    );
  }
  assertCapacity() {
    const row = z
      .object({ receipts: z.number(), reservations: z.number() })
      .parse(
        this.sql("SELECT receipts,reservations FROM delegation_capacity WHERE singleton=1").get(),
      );
    if (row.receipts + row.reservations >= this.capacity)
      throw new Error("Delegation journal capacity");
  }
  reservation(parent: ThreadId, request: string) {
    const row = this.sql(
      "SELECT reservation FROM delegation_reservations WHERE parent_id=? AND request_id=?",
    ).get(parent, request);
    return row
      ? DelegationReservation.parse(JSON.parse(z.string().parse(row.reservation)))
      : undefined;
  }
  reservations() {
    return this.sql("SELECT reservation FROM delegation_reservations ORDER BY child_id LIMIT 4")
      .all()
      .map((row) => DelegationReservation.parse(JSON.parse(z.string().parse(row.reservation))));
  }
  reserve(reservation: DelegationReservation) {
    this.assertCapacity();
    if (
      Number(
        this.sql("SELECT reservations FROM delegation_capacity WHERE singleton=1").get()
          ?.reservations,
      ) >= 4
    )
      throw new Error("Reservation capacity");
    const r = reservation.record;
    this.sql("INSERT INTO delegation_reservations VALUES (?,?,?,?,?)").run(
      r.childId,
      r.parentId,
      r.rootId,
      r.requestId,
      JSON.stringify(reservation),
    );
    this.sql("UPDATE delegation_capacity SET reservations=reservations+1 WHERE singleton=1").run();
    this.sql("UPDATE delegation_trees SET children=children+1,active=active+1 WHERE root_id=?").run(
      r.rootId,
    );
  }
  release(reservation: DelegationReservation) {
    const r = reservation.record;
    const deleted = this.sql("DELETE FROM delegation_reservations WHERE child_id=?").run(
      r.childId,
    ).changes;
    if (!deleted) return;
    this.sql("UPDATE delegation_capacity SET reservations=reservations-1 WHERE singleton=1").run();
    this.sql("UPDATE delegation_trees SET children=children-1,active=active-1 WHERE root_id=?").run(
      r.rootId,
    );
  }
  add(record: DelegationRecord) {
    const reservation = this.reservation(record.parentId, record.requestId);
    if (!reservation || reservation.record.childId !== record.childId)
      throw new Error("Missing reservation");
    this.sql("DELETE FROM delegation_reservations WHERE child_id=?").run(record.childId);
    this.sql("UPDATE delegation_capacity SET reservations=reservations-1 WHERE singleton=1").run();
    this.sql(
      "INSERT INTO delegated_threads(child_id,parent_id,root_id,request_id,record,phase) VALUES (?,?,?,?,?,?)",
    ).run(
      record.childId,
      record.parentId,
      record.rootId,
      record.requestId,
      JSON.stringify(record),
      record.phase,
    );
  }
  save(record: DelegationRecord) {
    this.sql("UPDATE delegated_threads SET record=?, phase=? WHERE child_id=?").run(
      JSON.stringify(record),
      record.phase,
      record.childId,
    );
  }
  activeCount() {
    return Number(
      this.sql(`SELECT (SELECT COUNT(*) FROM delegated_threads WHERE phase<>'settled') + reservations AS n
        FROM delegation_capacity WHERE singleton=1`).get()?.n,
    );
  }
  readMetadata(thread: ThreadId) {
    const row = this.sql(
      "SELECT pr_url,snoozed_until FROM agent_thread_metadata WHERE thread_id=?",
    ).get(thread);
    return row
      ? z.object({ pr_url: z.string().nullable(), snoozed_until: z.number().nullable() }).parse(row)
      : null;
  }
  active() {
    return this.sql(
      "SELECT record FROM delegated_threads WHERE phase<>'settled' ORDER BY child_id LIMIT 10001",
    )
      .all()
      .map((row) => this.decode(row.record));
  }
  family(root: ThreadId) {
    return this.sql(
      "SELECT record FROM delegated_threads WHERE root_id=? ORDER BY child_id LIMIT 64",
    )
      .all(root)
      .map((row) => this.decode(row.record));
  }
  isDescendant(target: ThreadId, ancestor: ThreadId): boolean {
    let child = this.get(target);
    for (let depth = 0; child && depth < 8; depth++) {
      if (child.parentId === ancestor) return true;
      child = this.get(child.parentId);
    }
    return false;
  }
  ancestorStopped(thread: ThreadId): boolean {
    return hasStoppedAncestor(thread, (id) => {
      const edge = this.get(id);
      return {
        ...(edge ? { parentId: edge.parentId } : {}),
        stopped: this.stopped(id) || edge?.phase === "cancelling",
      };
    });
  }
  reopen(record: DelegationRecord) {
    this.sql("DELETE FROM delegation_subtree_stops WHERE thread_id=?").run(record.childId);
    record.phase = "running";
    record.generation++;
    delete record.outcome;
    this.save(record);
    this.sql("UPDATE delegation_trees SET active=active+1 WHERE root_id=?").run(record.rootId);
    this.sql("UPDATE delegated_threads SET result_pending=0 WHERE child_id=?").run(record.childId);
    this.sql(
      "DELETE FROM delegation_wakes WHERE parent_id=? AND NOT EXISTS (SELECT 1 FROM delegated_threads WHERE parent_id=? AND result_pending=1)",
    ).run(record.parentId, record.parentId);
  }
  settle(record: DelegationRecord, outcome: DelegationOutcome, due: number) {
    if (record.phase === "settled") return;
    this.sql("UPDATE delegation_trees SET active=MAX(0,active-1) WHERE root_id=?").run(
      record.rootId,
    );
    record.phase = "settled";
    record.outcome = outcome;
    this.save(record);
    if (record.resultDelivery === "owner") return;
    this.sql("UPDATE delegated_threads SET result_pending=1 WHERE child_id=?").run(record.childId);
    this.sql("INSERT INTO delegation_wakes VALUES (?,?) ON CONFLICT(parent_id) DO NOTHING").run(
      record.parentId,
      due,
    );
  }
  nextWake() {
    const row = this.sql(
      "SELECT parent_id,due FROM delegation_wakes ORDER BY due,parent_id LIMIT 1",
    ).get();
    return row ? z.object({ parent_id: ThreadId, due: z.number() }).parse(row) : undefined;
  }
  nextExpiry(durationMs = 0) {
    const row = this.sql(
      "SELECT root_id,started_at,retry_at,failures,MAX(started_at+?,retry_at) AS due FROM delegation_trees WHERE cancelled=0 AND active>0 ORDER BY due,root_id LIMIT 1",
    ).get(durationMs);
    return row
      ? z
          .object({
            root_id: ThreadId,
            started_at: z.number(),
            retry_at: z.number(),
            failures: z.number(),
            due: z.number(),
          })
          .parse(row)
      : undefined;
  }
  deferExpiry(root: ThreadId, due: number) {
    this.sql(
      "UPDATE delegation_trees SET retry_at=?,failures=MIN(failures+1,30) WHERE root_id=?",
    ).run(due, root);
  }
  deferWake(parent: ThreadId, due: number) {
    this.sql("UPDATE delegation_wakes SET due=? WHERE parent_id=?").run(due, parent);
  }
  pending(parent: ThreadId) {
    return this.sql(
      "SELECT record FROM delegated_threads WHERE parent_id=? AND result_pending=1 ORDER BY child_id LIMIT 64",
    )
      .all(parent)
      .map((row) => this.decode(row.record));
  }
  consumeChild(child: ThreadId) {
    this.sql("UPDATE delegated_threads SET result_pending=0 WHERE child_id=?").run(child);
  }
  consume(parent: ThreadId) {
    this.sql(
      "UPDATE delegated_threads SET result_pending=0 WHERE parent_id=? AND result_pending=1",
    ).run(parent);
    this.sql("DELETE FROM delegation_wakes WHERE parent_id=?").run(parent);
  }
  stopped(thread: ThreadId) {
    return !!this.sql("SELECT thread_id FROM delegation_subtree_stops WHERE thread_id=?").get(
      thread,
    );
  }
  stop(thread: ThreadId) {
    this.sql("INSERT OR IGNORE INTO delegation_subtree_stops VALUES (?)").run(thread);
  }
  cancel(thread: ThreadId) {
    this.stop(thread);
    this.sql("UPDATE delegation_trees SET cancelled=1 WHERE root_id=?").run(thread);
  }
  metadata(thread: ThreadId, input: { prUrl?: string; until?: number | null }) {
    this.sql("INSERT OR IGNORE INTO agent_thread_metadata(thread_id) VALUES (?)").run(thread);
    if (input.prUrl !== undefined)
      this.sql("UPDATE agent_thread_metadata SET pr_url=? WHERE thread_id=?").run(
        input.prUrl,
        thread,
      );
    if (input.until !== undefined)
      this.sql("UPDATE agent_thread_metadata SET snoozed_until=? WHERE thread_id=?").run(
        input.until,
        thread,
      );
  }
  started(event: Event) {
    if (event.payload.type !== "run.started") return;
    this.sql(
      "INSERT INTO delegation_agent_runs VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET run_id=excluded.run_id",
    ).run(event.payload.run.agentId, event.payload.run.id);
  }
  /** The usage package owns provider counter semantics; this journal only persists its deltas. */
  usage(root: ThreadId, event: Event) {
    const p = event.payload;
    if (p.type !== "usage.updated") return;
    const provider =
      this.store.getMcpAgent(event.threadId, p.agentId)?.native.provider ??
      this.store.getThread(event.threadId)?.provider ??
      "unknown";
    const run = String(
      this.sql("SELECT run_id FROM delegation_agent_runs WHERE agent_id=?").get(p.agentId)
        ?.run_id ?? "unknown",
    );
    const policy = counterPolicy(p, provider, run);
    const key = policy.tracked ? policy.scope : `seq:${event.seq}`;
    const row = this.sql(
      "SELECT counts FROM delegation_usage WHERE root_id=? AND agent_id=? AND counter_key=?",
    ).get(root, p.agentId, key);
    const previous = row ? Counts.parse(JSON.parse(z.string().parse(row.counts))) : undefined;
    const { delta, next } = accountSample(p, provider, policy.mode, previous);
    const tokens = delta.input + delta.output;
    this.sql(
      "INSERT INTO delegation_usage VALUES (?,?,?,?,?,?) ON CONFLICT(root_id,agent_id,counter_key) DO UPDATE SET tokens=excluded.tokens,cost=excluded.cost,counts=excluded.counts",
    ).run(root, p.agentId, key, next.input + next.output, next.cost, JSON.stringify(next));
    this.sql(
      "UPDATE delegation_trees SET tokens=MIN(9007199254740991,tokens+?),cost=MIN(1.7976931348623157e308,cost+?) WHERE root_id=?",
    ).run(tokens, delta.cost, root);
  }
}
