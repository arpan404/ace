import { delegationRequest } from "./cursor-request.ts";
import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { AgentControlError } from "./failure.ts";
import { counterPolicy, accountSample, Counts } from "@ace/usage";
import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { DelegationRecord, ThreadId, type DelegationOutcome, type Event } from "@ace/protocol";
import type { Store } from "../store.ts";
import { DelegationOrigins, type OriginOwner } from "./delegation-origins.ts";
import { hasStoppedAncestor } from "./ancestor-stop.ts";

export const DelegationReservation = z.object({
  record: DelegationRecord,
  accountId: z.string().max(128).optional(),
});
export type DelegationReservation = z.infer<typeof DelegationReservation>;
const treeRow = z.object({
  root_id: ThreadId,
  tokens: z.number(),
  cost: z.number(),
});
/** One writer on Store's transaction boundary; only indexed current rows enter memory. */
export class DelegationJournal {
  private store: Store;
  private capacity: number;
  private statements = new Map<string, StatementSync>();
  /** The parent turn each delegation generation came from. */
  readonly origins: DelegationOrigins;
  constructor(store: Store, capacity = 10000) {
    this.capacity = z.number().int().min(1).max(10000).parse(capacity);
    this.store = store;
    this.origins = new DelegationOrigins(store);
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS delegation_trees (
        root_id TEXT PRIMARY KEY REFERENCES threads(id), started_at INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS delegation_participants (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL REFERENCES delegation_trees(root_id), active INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS delegation_participant_active ON delegation_participants(thread_id) WHERE active=1;
      CREATE INDEX IF NOT EXISTS delegation_participant_root ON delegation_participants(root_id,active,thread_id);
      CREATE TRIGGER IF NOT EXISTS delegation_participant_activity AFTER UPDATE OF active ON delegation_participants BEGIN
        UPDATE delegation_trees SET active=MAX(0,active+NEW.active-OLD.active) WHERE root_id=NEW.root_id;
      END;
      CREATE TRIGGER IF NOT EXISTS delegation_participant_deleted AFTER DELETE ON delegation_participants BEGIN
        UPDATE delegation_trees SET active=MAX(0,active-OLD.active) WHERE root_id=OLD.root_id;
      END;
      CREATE TABLE IF NOT EXISTS delegated_threads (
        child_id TEXT PRIMARY KEY REFERENCES threads(id), parent_id TEXT NOT NULL REFERENCES threads(id),
        root_id TEXT NOT NULL REFERENCES delegation_trees(root_id), request_id TEXT NOT NULL,
        record JSON NOT NULL, phase TEXT NOT NULL, result_pending INTEGER NOT NULL DEFAULT 0,
        wake_suppressed INTEGER NOT NULL DEFAULT 0, UNIQUE(parent_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS delegated_parent ON delegated_threads(parent_id, phase);
      CREATE INDEX IF NOT EXISTS delegated_root ON delegated_threads(root_id, child_id);
      CREATE INDEX IF NOT EXISTS delegated_active ON delegated_threads(child_id) WHERE phase<>'settled';
      CREATE INDEX IF NOT EXISTS delegated_live_root ON delegated_threads(root_id,phase);
      CREATE TABLE IF NOT EXISTS delegation_reservations (
        child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, root_id TEXT NOT NULL,
        request_id TEXT NOT NULL, reservation JSON NOT NULL, UNIQUE(parent_id,request_id)
      );
      CREATE INDEX IF NOT EXISTS delegation_reserved_parent ON delegation_reservations(parent_id);
      CREATE INDEX IF NOT EXISTS delegated_results ON delegated_threads(parent_id, result_pending, child_id);
      CREATE TABLE IF NOT EXISTS delegation_subtree_stops (thread_id TEXT PRIMARY KEY REFERENCES threads(id));
      CREATE TABLE IF NOT EXISTS delegation_member_stops (thread_id TEXT PRIMARY KEY REFERENCES threads(id));
      CREATE TABLE IF NOT EXISTS delegation_wakes (
        parent_id TEXT PRIMARY KEY REFERENCES threads(id), due INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delegation_wake_due ON delegation_wakes(due,parent_id);
      CREATE TABLE IF NOT EXISTS delegation_usage (
        root_id TEXT NOT NULL, agent_id TEXT NOT NULL, counter_key TEXT NOT NULL,
        tokens INTEGER NOT NULL, cost REAL NOT NULL, counts JSON NOT NULL, PRIMARY KEY(root_id,agent_id,counter_key)
      );
      CREATE TABLE IF NOT EXISTS delegation_usage_offsets (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id), seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegation_agent_runs (agent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_thread_metadata (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id), snoozed_until INTEGER
      );
    `),
    );
    // Owners of delegations made before they were kept, once (`DelegationOrigins.backfill`).
    if (!this.origins.backfilled())
      this.origins.backfill([
        ...this.sql("SELECT record FROM delegated_threads")
          .all()
          .map((row) => {
            const edge = this.decode(row.record);
            return edgeOwnerFacts(edge, edge.phase !== "settled");
          }),
        ...this.reservations().map((reservation) => edgeOwnerFacts(reservation.record, true)),
      ]);
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
    const record = DelegationRecord.parse(JSON.parse(z.string().parse(value)));
    return { ...record, request: delegationRequest(record.request) };
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
  /** The root whose tree this thread belongs to: its own when it was never delegated. */
  rootOf(thread: ThreadId): ThreadId {
    return this.get(thread)?.rootId ?? this.participant(thread)?.root_id ?? thread;
  }
  tree(thread: ThreadId, now: number) {
    const edge = this.get(thread);
    const root = this.rootOf(thread);
    this.sql("INSERT OR IGNORE INTO delegation_trees(root_id,started_at) VALUES (?,?)").run(
      root,
      now,
    );
    const row = treeRow.parse(
      this.sql("SELECT root_id,tokens,cost FROM delegation_trees WHERE root_id=?").get(root),
    );
    return { root, depth: edge?.depth ?? 0, usage: { tokens: row.tokens, cost: row.cost } };
  }
  /** Budget membership grants no child attachment or write authority. */
  enroll(thread: ThreadId, root: ThreadId) {
    this.sql("INSERT OR IGNORE INTO delegation_participants(thread_id,root_id) VALUES (?,?)").run(
      thread,
      root,
    );
  }
  participant(thread: ThreadId) {
    const row = this.sql(
      "SELECT root_id,active FROM delegation_participants WHERE thread_id=?",
    ).get(thread);
    return row ? z.object({ root_id: ThreadId, active: z.number() }).parse(row) : undefined;
  }
  activity(thread: ThreadId, active: 0 | 1) {
    this.sql("UPDATE delegation_participants SET active=? WHERE thread_id=? AND active<>?").run(
      active,
      thread,
      active,
    );
  }
  activeParticipants() {
    return this.sql(
      "SELECT thread_id,root_id FROM delegation_participants WHERE active=1 ORDER BY thread_id LIMIT 10001",
    )
      .all()
      .map((row) => z.object({ thread_id: ThreadId, root_id: ThreadId }).parse(row));
  }
  /** Children holding a run slot. Created, queued and settled children hold none. */
  running(parent: ThreadId) {
    return Number(
      this.sql(
        "SELECT COUNT(*) AS n FROM delegated_threads WHERE parent_id=? AND phase IN ('running','cancelling')",
      ).get(parent)?.n,
    );
  }
  /** Bounds live rows recovery loads into memory; settled history never counts. */
  assertCapacity() {
    const live = Number(
      this.sql(`SELECT (SELECT COUNT(*) FROM delegated_threads WHERE phase<>'settled') +
        (SELECT COUNT(*) FROM delegation_reservations) AS n`).get()?.n,
    );
    if (live >= this.capacity)
      throw new AgentControlError("delegation_limit", "Delegation journal capacity");
  }
  private decodeReservation(value: unknown) {
    const reservation = DelegationReservation.parse(JSON.parse(z.string().parse(value)));
    return {
      ...reservation,
      record: { ...reservation.record, request: delegationRequest(reservation.record.request) },
      ...(reservation.record.request.provider === "cursor" && reservation.accountId
        ? { accountId: cursorInstanceId(reservation.accountId) }
        : {}),
    };
  }
  reservation(parent: ThreadId, request: string) {
    const row = this.sql(
      "SELECT reservation FROM delegation_reservations WHERE parent_id=? AND request_id=?",
    ).get(parent, request);
    return row ? this.decodeReservation(row.reservation) : undefined;
  }
  /** The reservation still preparing `child`, if it is one. */
  reservationOf(child: ThreadId) {
    const row = this.sql("SELECT reservation FROM delegation_reservations WHERE child_id=?").get(
      child,
    );
    return row ? this.decodeReservation(row.reservation) : undefined;
  }
  /** In-flight preparations only; each is released or committed when its owner finishes. */
  reservations() {
    return this.sql("SELECT reservation FROM delegation_reservations ORDER BY child_id")
      .all()
      .map((row) => this.decodeReservation(row.reservation));
  }
  reserve(reservation: DelegationReservation) {
    this.assertCapacity();
    const r = reservation.record;
    this.origins.note(r.childId, r.generation, r.parentId, { kind: "parent-turn" });
    this.sql("INSERT INTO delegation_reservations VALUES (?,?,?,?,?)").run(
      r.childId,
      r.parentId,
      r.rootId,
      r.requestId,
      JSON.stringify(reservation),
    );
    this.sql("UPDATE delegation_trees SET active=active+1 WHERE root_id=?").run(r.rootId);
  }
  release(reservation: DelegationReservation) {
    const r = reservation.record;
    const deleted = this.sql("DELETE FROM delegation_reservations WHERE child_id=?").run(
      r.childId,
    ).changes;
    if (!deleted) return;
    this.sql("UPDATE delegation_trees SET active=active-1 WHERE root_id=?").run(r.rootId);
  }
  add(record: DelegationRecord) {
    const reservation = this.reservation(record.parentId, record.requestId);
    if (!reservation || reservation.record.childId !== record.childId)
      throw new Error("Missing reservation");
    this.sql("DELETE FROM delegation_reservations WHERE child_id=?").run(record.childId);
    this.origins.note(record.childId, record.generation, record.parentId, { kind: "parent-turn" });
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
  readMetadata(thread: ThreadId) {
    const row = this.sql("SELECT snoozed_until FROM agent_thread_metadata WHERE thread_id=?").get(
      thread,
    );
    return row ? z.object({ snoozed_until: z.number().nullable() }).parse(row) : null;
  }
  active() {
    return this.sql(
      "SELECT record FROM delegated_threads WHERE phase<>'settled' ORDER BY child_id LIMIT 10001",
    )
      .all()
      .map((row) => this.decode(row.record));
  }
  /** Recovery also restores ownership of provider work committed just before a crash. */
  revived() {
    return this.sql(`SELECT record FROM delegated_threads JOIN threads ON threads.id=child_id
      WHERE phase='settled' AND json_extract(threads.status,'$.state') NOT IN ('done','failed','new')
      AND json_extract(threads.client,'$.deletedAt') IS NULL ORDER BY child_id LIMIT 10001`)
      .all()
      .map((row) => this.decode(row.record));
  }
  /** Direct children, settled ones included. */
  /** Unsettled direct children only, read through the parent/phase index. */
  liveChildren(parent: ThreadId) {
    return this.sql(
      "SELECT record FROM delegated_threads WHERE parent_id=? AND phase<>'settled' ORDER BY child_id",
    )
      .all(parent)
      .map((row) => this.decode(row.record));
  }
  children(parent: ThreadId) {
    return this.sql("SELECT record FROM delegated_threads WHERE parent_id=? ORDER BY child_id")
      .all(parent)
      .map((row) => this.decode(row.record));
  }
  /** Every delegated descendant at any depth, settled ones included. */
  descendants(thread: ThreadId) {
    return this.sql(`WITH RECURSIVE tree(id,level) AS (
        SELECT child_id,1 FROM delegated_threads WHERE parent_id=?
        UNION ALL SELECT d.child_id,tree.level+1 FROM delegated_threads d JOIN tree ON d.parent_id=tree.id
        WHERE tree.level<8
      ) SELECT record FROM delegated_threads JOIN tree ON child_id=tree.id ORDER BY child_id`)
      .all(thread)
      .map((row) => this.decode(row.record));
  }
  /** Unsettled descendants; reads only the tree's live rows, never its settled history. */
  liveDescendants(thread: ThreadId) {
    return this.sql(
      "SELECT record FROM delegated_threads WHERE root_id=? AND phase<>'settled' ORDER BY child_id",
    )
      .all(this.rootOf(thread))
      .map((row) => this.decode(row.record))
      .filter((edge) => this.isDescendant(edge.childId, thread));
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
        // A filtered host stop fences this member's admission, not its unselected children.
        // A root's Stop never fences: only cancelled delegated children carry the fence.
        stopped:
          !!edge &&
          (this.subtreeStopped(id) || (edge.phase === "cancelling" && !this.memberStopped(id))),
      };
    });
  }
  /** Being cancelled, or under a cancelled ancestor: this thread may not start new children. */
  fenced(thread: ThreadId): boolean {
    const edge = this.get(thread);
    return (
      (!!edge && (edge.phase === "cancelling" || this.subtreeStopped(thread))) ||
      this.ancestorStopped(thread)
    );
  }
  /** New input reopens a settled child: `byParent` when its parent agent sent it. */
  reopen(record: DelegationRecord, now: number, byParent: boolean) {
    this.sql("DELETE FROM delegation_subtree_stops WHERE thread_id=?").run(record.childId);
    this.sql("DELETE FROM delegation_member_stops WHERE thread_id=?").run(record.childId);
    this.sql("UPDATE delegated_threads SET wake_suppressed=0 WHERE child_id=?").run(record.childId);
    this.revive(record, byParent ? { kind: "parent-turn" } : { kind: "independent" });
    this.rearm(record.childId, now);
  }
  /**
   * Native work must be counted even when Stop still owns its cancellation. The new generation
   * belongs to `owner`; a native revival carries on the generation before it.
   */
  revive(record: DelegationRecord, owner?: OriginOwner) {
    if (record.phase !== "settled") return;
    const previous = record.generation;
    record.phase = "running";
    record.generation++;
    delete record.outcome;
    this.save(record);
    this.origins.note(
      record.childId,
      record.generation,
      record.parentId,
      owner ?? { kind: "same-as", generation: previous },
    );
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
    if (
      this.sql("SELECT wake_suppressed FROM delegated_threads WHERE child_id=?").get(record.childId)
        ?.wake_suppressed === 1
    )
      return;
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
  deferWake(parent: ThreadId, due: number) {
    this.sql("UPDATE delegation_wakes SET due=? WHERE parent_id=?").run(due, parent);
  }
  /** One delivery page of undelivered results; later pages stay pending for the next wake. */
  pending(parent: ThreadId, limit = 64) {
    return this.sql(
      "SELECT record FROM delegated_threads WHERE parent_id=? AND result_pending=1 ORDER BY child_id LIMIT ?",
    )
      .all(parent, limit)
      .map((row) => this.decode(row.record));
  }
  consumeChild(child: ThreadId) {
    this.sql("UPDATE delegated_threads SET result_pending=0 WHERE child_id=?").run(child);
  }
  /** Marks exactly these results delivered. The wake stays due while any result remains. */
  consumeDelivered(parent: ThreadId, children: readonly ThreadId[]) {
    for (const child of children)
      this.sql(
        "UPDATE delegated_threads SET result_pending=0 WHERE child_id=? AND parent_id=?",
      ).run(child, parent);
    if (!this.hasPending(parent))
      this.sql("DELETE FROM delegation_wakes WHERE parent_id=?").run(parent);
  }
  /** The parent is gone: nothing can read these results. */
  discard(parent: ThreadId) {
    this.sql(
      "UPDATE delegated_threads SET result_pending=0 WHERE parent_id=? AND result_pending=1",
    ).run(parent);
    this.sql("DELETE FROM delegation_wakes WHERE parent_id=?").run(parent);
  }
  /** A stopped parent is not woken; its results stay pending until it takes new input. */
  holdWake(parent: ThreadId) {
    this.sql("DELETE FROM delegation_wakes WHERE parent_id=?").run(parent);
  }
  rearm(parent: ThreadId, due: number) {
    if (!this.hasPending(parent)) return;
    this.sql("INSERT INTO delegation_wakes VALUES (?,?) ON CONFLICT(parent_id) DO NOTHING").run(
      parent,
      due,
    );
  }
  private hasPending(parent: ThreadId) {
    return !!this.sql(
      "SELECT 1 FROM delegated_threads WHERE parent_id=? AND result_pending=1 LIMIT 1",
    ).get(parent);
  }
  stopped(thread: ThreadId) {
    return this.subtreeStopped(thread) || this.memberStopped(thread);
  }
  private subtreeStopped(thread: ThreadId) {
    return !!this.sql("SELECT thread_id FROM delegation_subtree_stops WHERE thread_id=?").get(
      thread,
    );
  }
  private memberStopped(thread: ThreadId) {
    return !!this.sql("SELECT thread_id FROM delegation_member_stops WHERE thread_id=?").get(
      thread,
    );
  }
  stopMember(thread: ThreadId) {
    this.sql("INSERT OR IGNORE INTO delegation_member_stops VALUES (?)").run(thread);
  }
  /** Explicit accepted work restores only this member's authority and result delivery. */
  resumeMember(thread: ThreadId, now: number) {
    if (!this.memberStopped(thread)) return;
    this.sql("DELETE FROM delegation_member_stops WHERE thread_id=?").run(thread);
    if (!this.subtreeStopped(thread))
      this.sql("UPDATE delegated_threads SET wake_suppressed=0 WHERE child_id=?").run(thread);
    this.rearm(thread, now);
  }
  stop(thread: ThreadId) {
    this.sql("INSERT OR IGNORE INTO delegation_subtree_stops VALUES (?)").run(thread);
  }
  suppressWake(child: ThreadId) {
    this.sql(
      "UPDATE delegated_threads SET wake_suppressed=1,result_pending=0 WHERE child_id=?",
    ).run(child);
  }
  /**
   * Stop on a delegated child cancels it with its subtree. Stop on a root only holds its
   * result wakes: it never fences the root's future children or its later admissions.
   */
  cancel(thread: ThreadId) {
    if (this.get(thread)) this.stop(thread);
    else this.stopMember(thread);
  }
  /** A new accepted person input reopens only the root, preserving child stops. */
  resumeRoot(thread: ThreadId, now: number) {
    this.sql("DELETE FROM delegation_subtree_stops WHERE thread_id=?").run(thread);
    this.sql("DELETE FROM delegation_member_stops WHERE thread_id=?").run(thread);
    this.rearm(thread, now);
  }
  usageOffset(thread: ThreadId): number {
    return Number(
      this.sql("SELECT seq FROM delegation_usage_offsets WHERE thread_id=?").get(thread)?.seq ?? 0,
    );
  }
  usageThreads(after: string) {
    return this.sql(`SELECT child_id AS thread_id,root_id FROM delegated_threads WHERE child_id>?
        UNION ALL SELECT thread_id,root_id FROM delegation_participants WHERE thread_id>?
        ORDER BY thread_id LIMIT 64`)
      .all(after, after)
      .map((row) => z.object({ thread_id: ThreadId, root_id: ThreadId }).parse(row));
  }
  /** Counters and the replay position share one commit, including incremental samples. */
  account(root: ThreadId, event: Event): void {
    if (event.payload.type !== "run.started" && event.payload.type !== "usage.updated") return;
    this.store.atomic(() => {
      if (event.seq <= this.usageOffset(event.threadId)) return;
      this.started(event);
      this.usage(root, event);
      this.sql(
        "INSERT INTO delegation_usage_offsets VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET seq=excluded.seq",
      ).run(event.threadId, event.seq);
    });
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

/** What owner backfill needs of a delegation. */
function edgeOwnerFacts(edge: DelegationRecord, live: boolean) {
  return {
    childId: edge.childId,
    parentId: edge.parentId,
    generation: edge.generation,
    createdAt: edge.createdAt,
    live,
  };
}
