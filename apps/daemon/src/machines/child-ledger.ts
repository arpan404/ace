import { z } from "zod";
import { AgentId, MachineMessage, MachineThreadView, ProviderKind, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

export const ChildRow = z.object({
  id: ThreadId,
  parent_thread: ThreadId,
  parent_agent: AgentId,
  machine: z.string(),
  role: z.string(),
  provider: ProviderKind,
  model: z.string().nullable(),
  created_at: z.number(),
  view: z.string().nullable(),
  settled: z.number(),
  delivered: z.number(),
  /** Advances with each piece of new work sent, fencing status replies read before it. */
  generation: z.number(),
  settled_at: z.number().nullable(),
  /**
   * The re-check turn it was last asked about in once settled; on each machine lower turns go
   * first, so every settled child is re-checked in turn however many there are.
   */
  rechecked: z.number(),
  /** The paired device it was delegated through; null for children from before it was kept. */
  device_id: z.string().nullable(),
  /** When its pairing was found gone; null while it is reachable. */
  lost_at: z.number().nullable(),
  /** The approval its parent shows the person while it is lost: key and interaction id. */
  lost_key: z.string().nullable(),
  lost_ask: z.string().nullable(),
});
export type ChildRow = z.infer<typeof ChildRow>;

/** The last view a child's machine reported, if any. */
export function savedView(row: ChildRow): MachineThreadView | undefined {
  return row.view ? MachineThreadView.parse(JSON.parse(row.view)) : undefined;
}

/**
 * The durable record of children this machine delegated to others (`machine_children`, owned
 * by the store's migrations in machine-tables.ts). Reads and writes only: what they mean for the
 * parent is the caller's (children.ts).
 */
export class ChildLedger {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  row(id: string): ChildRow | undefined {
    const raw = this.store.atomic((db) =>
      db.prepare("SELECT * FROM machine_children WHERE id=?").get(id),
    );
    return raw ? ChildRow.parse(raw) : undefined;
  }
  private all(sql: string, ...values: (string | number)[]): ChildRow[] {
    return this.store
      .atomic((db) => db.prepare(sql).all(...values))
      .map((raw) => ChildRow.parse(raw));
  }
  /** True while a child is unsettled or its settled result is not yet delivered. */
  hasOpen(): boolean {
    return Boolean(
      this.store.atomic((db) =>
        db
          .prepare(
            "SELECT 1 WHERE EXISTS(SELECT 1 FROM machine_children WHERE settled=0) OR EXISTS(SELECT 1 FROM machine_children WHERE settled=1 AND delivered=0)",
          )
          .get(),
      ),
    );
  }
  /** The machines to serve next, those served longest ago first, with where each stopped. */
  machinesDue(limit: number): { machine: string; after: string | null }[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT machine, after FROM machine_child_cursors ORDER BY served, machine LIMIT ?",
          )
          .all(limit),
      )
      .map((row) => ({
        machine: z.string().parse(row.machine),
        after: z.string().nullable().parse(row.after),
      }));
  }
  /**
   * Up to `limit` of a machine's unsettled children after `after` in id order, continuing from
   * the first once the last is passed, so the machine's children are read in a cycle.
   */
  unsettledAfter(machine: string, after: string | null, limit: number): ChildRow[] {
    const next = this.all(
      "SELECT * FROM machine_children WHERE settled=0 AND machine=? AND id>? ORDER BY id LIMIT ?",
      machine,
      after ?? "",
      limit,
    );
    if (after === null || next.length >= limit) return next;
    return [
      ...next,
      ...this.all(
        "SELECT * FROM machine_children WHERE settled=0 AND machine=? AND id<=? ORDER BY id LIMIT ?",
        machine,
        after,
        limit - next.length,
      ),
    ];
  }
  /** The machine was served in `turn`, reading up to `after`: one write per machine. */
  markServed(machine: string, turn: number, after: string): void {
    this.store.atomic((db) =>
      db
        .prepare("UPDATE machine_child_cursors SET served=?, after=? WHERE machine=?")
        .run(turn, after, machine),
    );
  }
  /** Leaves the rotation once the machine has no unsettled child; a new one brings it back. */
  untrack(machine: string): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "DELETE FROM machine_child_cursors WHERE machine=? AND NOT EXISTS(SELECT 1 FROM machine_children WHERE settled=0 AND machine=?)",
        )
        .run(machine, machine),
    );
  }
  /** The latest turn a machine was served in. */
  lastServedTurn(): number {
    return Number(
      this.store.atomic((db) =>
        db.prepare("SELECT COALESCE(MAX(served),0) AS turn FROM machine_child_cursors").get(),
      )?.turn ?? 0,
    );
  }
  /** Settled children whose result the parent has not taken yet. */
  undelivered(): ChildRow[] {
    return this.all(
      "SELECT * FROM machine_children WHERE settled=1 AND delivered=0 ORDER BY settled_at",
    );
  }
  /** Every child delegated from these threads: unsettled first, then oldest first. */
  ofParents(parents: readonly string[]): ChildRow[] {
    return chunks(parents).flatMap((ids) =>
      this.all(
        `SELECT * FROM machine_children WHERE parent_thread IN (${ids.map(() => "?").join(",")}) ORDER BY settled, created_at`,
        ...ids,
      ),
    );
  }
  /** The unsettled children delegated from these threads. */
  unsettledOfParents(parents: readonly string[]): ThreadId[] {
    return chunks(parents).flatMap((ids) =>
      this.store
        .atomic((db) =>
          db
            .prepare(
              `SELECT id FROM machine_children WHERE settled=0 AND parent_thread IN (${ids.map(() => "?").join(",")})`,
            )
            .all(...ids),
        )
        .map((row) => ThreadId.parse(row.id)),
    );
  }
  byRequest(key: string): ThreadId | undefined {
    const raw = this.store.atomic((db) =>
      db.prepare("SELECT id FROM machine_children WHERE request_key=?").get(key),
    );
    return raw ? ThreadId.parse(raw.id) : undefined;
  }
  insert(child: {
    id: ThreadId;
    requestKey: string;
    parentThreadId: ThreadId;
    parentAgentId: AgentId;
    machine: string;
    role: string;
    provider: ProviderKind;
    model?: string | undefined;
    createdAt: number;
    view: MachineThreadView | undefined;
    device: string | undefined;
  }): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO machine_children (id,request_key,parent_thread,parent_agent,machine,role,provider,model,created_at,view,device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          child.id,
          child.requestKey,
          child.parentThreadId,
          child.parentAgentId,
          child.machine,
          child.role,
          child.provider,
          child.model ?? null,
          child.createdAt,
          child.view ? JSON.stringify(child.view) : null,
          child.device ?? null,
        ),
    );
    this.track(child.machine);
  }
  /** The machine may have unsettled children: it joins the polling rotation. */
  private track(machine: string): void {
    this.store.atomic((db) =>
      db.prepare("INSERT OR IGNORE INTO machine_child_cursors (machine) VALUES (?)").run(machine),
    );
  }
  /** Status replies read before now no longer apply to the child. */
  advance(id: ThreadId): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET generation=generation+1 WHERE id=?").run(id),
    );
  }
  /**
   * A message is on its way to the child: kept until its machine answers for it, and status
   * replies read before now no longer apply.
   */
  addMessage(id: ThreadId, message: MachineMessage, now: number): void {
    this.store.atomic((db) => {
      db.prepare(
        "INSERT OR IGNORE INTO machine_child_messages (child_id,request_id,message,created_at) VALUES (?,?,?,?)",
      ).run(id, message.requestId, JSON.stringify(message), now);
      db.prepare("UPDATE machine_children SET generation=generation+1 WHERE id=?").run(id);
    });
  }
  /** Its machine answered for the message: taken, or refused so it never runs. */
  resolveMessage(id: ThreadId, requestId: string): void {
    this.store.atomic((db) =>
      db
        .prepare("DELETE FROM machine_child_messages WHERE child_id=? AND request_id=?")
        .run(id, requestId),
    );
  }
  /** True while a message to the child is unanswered. */
  hasMessages(id: ThreadId): boolean {
    return Boolean(
      this.store.atomic((db) =>
        db.prepare("SELECT 1 FROM machine_child_messages WHERE child_id=? LIMIT 1").get(id),
      ),
    );
  }
  /** True while any message to any child is unanswered. */
  anyMessages(): boolean {
    return Boolean(
      this.store.atomic((db) => db.prepare("SELECT 1 FROM machine_child_messages LIMIT 1").get()),
    );
  }
  /**
   * Unanswered messages due a retry by `now`, those due longest first, leaving out the ones being
   * sent now (`busy`, as "child:request") and machines with no room for another (`full`). Both
   * are left out before the limit, so they never crowd out a message that could go.
   */
  dueMessages(
    now: number,
    limit: number,
    busy: readonly string[],
    full: readonly string[],
  ): { child: ChildRow; message: MachineMessage; attempts: number }[] {
    const notBusy = busy.length
      ? ` AND (m.child_id||':'||m.request_id) NOT IN (${busy.map(() => "?").join(",")})`
      : "";
    const notFull = full.length ? ` AND c.machine NOT IN (${full.map(() => "?").join(",")})` : "";
    const raw = this.store.atomic((db) =>
      db
        .prepare(
          `SELECT m.child_id,m.message,m.attempts FROM machine_child_messages m JOIN machine_children c ON c.id=m.child_id WHERE m.next_retry_at<=?${notBusy}${notFull} ORDER BY m.next_retry_at, m.created_at LIMIT ?`,
        )
        .all(now, ...busy, ...full, limit),
    );
    return raw.flatMap((entry) => {
      const child = this.row(z.string().parse(entry.child_id));
      return child
        ? [
            {
              child,
              message: MachineMessage.parse(JSON.parse(z.string().parse(entry.message))),
              attempts: Number(entry.attempts),
            },
          ]
        : [];
    });
  }
  /** A retry of the message is starting: the next one waits until `next`. */
  deferMessage(id: ThreadId, requestId: string, next: number): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE machine_child_messages SET attempts=attempts+1, next_retry_at=? WHERE child_id=? AND request_id=?",
        )
        .run(next, id, requestId),
    );
  }
  /** Open again, with no view until its machine is read. */
  markReopened(id: ThreadId): void {
    this.store.atomic((db) => {
      db.prepare("UPDATE machine_children SET settled=0, delivered=0, view=NULL WHERE id=?").run(
        id,
      );
      db.prepare(
        "INSERT OR IGNORE INTO machine_child_cursors (machine) SELECT machine FROM machine_children WHERE id=?",
      ).run(id);
    });
  }
  /** The machine's latest view; a settle also starts the re-check window. */
  writeView(id: ThreadId, view: string, settled: boolean, now: number): void {
    this.store.atomic((db) => {
      db.prepare("UPDATE machine_children SET view=?, settled=? WHERE id=?").run(
        view,
        settled ? 1 : 0,
        id,
      );
      if (settled) db.prepare("UPDATE machine_children SET settled_at=? WHERE id=?").run(now, id);
    });
  }
  /** Its pairing is gone: lost, still unsettled, until it returns or the person stops tracking. */
  markLost(id: ThreadId, at: number): void {
    this.store.atomic((db) =>
      db
        .prepare("UPDATE machine_children SET lost_at=? WHERE id=? AND lost_at IS NULL")
        .run(at, id),
    );
  }
  /** The approval its parent now shows the person about it. */
  setLostAsk(id: ThreadId, key: string, ask: string): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET lost_key=?, lost_ask=? WHERE id=?").run(key, ask, id),
    );
  }
  /** Its pairing is back: tracked again. */
  clearLost(id: ThreadId): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE machine_children SET lost_at=NULL, lost_key=NULL, lost_ask=NULL WHERE id=?",
        )
        .run(id),
    );
  }
  /** The lost child the parent's approval `ask` is about. */
  byLostAsk(ask: string): ChildRow | undefined {
    return this.all("SELECT * FROM machine_children WHERE lost_ask=?", ask)[0];
  }
  /**
   * The person stopped tracking a lost child: settled with `view`, its unanswered messages
   * dropped (none can be sent), and no re-check window (`settled_at` null).
   */
  markAbandoned(id: ThreadId, view: string): void {
    this.store.atomic((db) => {
      db.prepare("DELETE FROM machine_child_messages WHERE child_id=?").run(id);
      db.prepare(
        "UPDATE machine_children SET view=?, settled=1, settled_at=NULL, lost_key=NULL, lost_ask=NULL WHERE id=?",
      ).run(view, id);
    });
  }
  markDelivered(id: string): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET delivered=1 WHERE id=?").run(id),
    );
  }
  /** The parent took its settled result. */
  markResultDelivered(id: string): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET delivered=1 WHERE id=? AND settled=1").run(id),
    );
  }
  /** True while any child settled at or after `since`. */
  hasRecentlySettled(since: number): boolean {
    return Boolean(
      this.store.atomic((db) =>
        db
          .prepare("SELECT 1 FROM machine_children WHERE settled=1 AND settled_at>=? LIMIT 1")
          .get(since),
      ),
    );
  }
  /** Machines with a child settled at or after `since`. */
  recheckMachines(since: number): string[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT DISTINCT machine FROM machine_children WHERE settled=1 AND settled_at>=?",
          )
          .all(since),
      )
      .map((row) => z.string().parse(row.machine));
  }
  /** One machine's settled children due a re-check, those checked longest ago first. */
  recheckTurn(machine: string, since: number, limit: number): ChildRow[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT * FROM machine_children WHERE settled=1 AND machine=? AND settled_at>=? ORDER BY rechecked, id LIMIT ?",
          )
          .all(machine, since, limit),
      )
      .map((raw) => ChildRow.parse(raw));
  }
  /** The latest re-check turn recorded. */
  lastRecheckTurn(): number {
    return Number(
      this.store.atomic((db) =>
        db.prepare("SELECT COALESCE(MAX(rechecked),0) AS turn FROM machine_children").get(),
      )?.turn ?? 0,
    );
  }
  markRechecked(ids: readonly string[], turn: number): void {
    this.store.atomic((db) => {
      const mark = db.prepare("UPDATE machine_children SET rechecked=? WHERE id=?");
      for (const id of ids) mark.run(turn, id);
    });
  }
}

/** SQLite caps bound values per statement; long id lists go in pieces. */
function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let index = 0; index < ids.length; index += 500) out.push(ids.slice(index, index + 500));
  return out;
}
