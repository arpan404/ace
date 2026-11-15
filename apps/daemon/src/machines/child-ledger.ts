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
  /** When its machine last reported it: the proof its lease runs from (ADR 0052). */
  seen_at: z.number().nullable(),
  /** Its lease lapsed: lost contact since then, no longer holding its parent. */
  silent_since: z.number().nullable(),
  /** A Stop in progress: when it began, cancels sent and when the last went. */
  stop_started_at: z.number().nullable(),
  stop_attempts: z.number(),
  stop_last_at: z.number().nullable(),
  /**
   * Stopped here after every cancel went unconfirmed; a late report never revives it. 1: the
   * cancel is still sent; 2: its machine confirmed late; 3: it can never confirm (unpaired).
   */
  stopped_unconfirmed: z.number(),
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
  /** True while a child is unsettled. */
  hasUnsettled(): boolean {
    return Boolean(
      this.store.atomic((db) =>
        db.prepare("SELECT 1 FROM machine_children WHERE settled=0 LIMIT 1").get(),
      ),
    );
  }
  /** True while a settled child's result is not yet delivered. */
  hasUndelivered(): boolean {
    return Boolean(
      this.store.atomic((db) =>
        db.prepare("SELECT 1 FROM machine_children WHERE settled=1 AND delivered=0 LIMIT 1").get(),
      ),
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
          "INSERT INTO machine_children (id,request_key,parent_thread,parent_agent,machine,role,provider,model,created_at,view,device_id,seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
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
          child.createdAt,
        ),
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
  /**
   * Its machine answered for the message: taken, or refused so it never runs. False when the
   * record was already gone (answered before, or dropped when the person stopped tracking the
   * child), so the answer changes nothing.
   */
  resolveMessage(id: ThreadId, requestId: string): boolean {
    return this.store.atomic(
      (db) =>
        Number(
          db
            .prepare("DELETE FROM machine_child_messages WHERE child_id=? AND request_id=?")
            .run(id, requestId).changes,
        ) > 0,
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
    this.store.atomic((db) =>
      db
        .prepare("UPDATE machine_children SET settled=0, delivered=0, view=NULL WHERE id=?")
        .run(id),
    );
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
  /**
   * Settled children whose machine was unpaired before a check after their 24 h mark: the
   * person is asked about each, and none is re-checked until its machine is paired again.
   */
  settledLost(): ChildRow[] {
    return this.all(
      "SELECT * FROM machine_children WHERE settled=1 AND lost_at IS NOT NULL AND settled_at IS NOT NULL",
    );
  }
  /** The person stopped watching a settled lost child: it stays as it ended, for good. */
  endWatch(id: ThreadId): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET settled_at=NULL WHERE id=? AND settled=1").run(id),
    );
  }
  /** The lost child the parent's approval `ask` is about. */
  byLostAsk(ask: string): ChildRow | undefined {
    return this.all("SELECT * FROM machine_children WHERE lost_ask=?", ask)[0];
  }
  /** Its machine reported it at `at`: its lease runs from then, and it is in contact again. */
  seen(id: ThreadId, at: number): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE machine_children SET seen_at=MAX(COALESCE(seen_at,0),?), silent_since=NULL WHERE id=?",
        )
        .run(at, id),
    );
  }
  /** Its lease lapsed at `since`: lost contact until it reports again. */
  markSilent(id: ThreadId, since: number): void {
    this.store.atomic((db) =>
      db
        .prepare("UPDATE machine_children SET silent_since=? WHERE id=? AND silent_since IS NULL")
        .run(since, id),
    );
  }
  /** A Stop began at `at`; false when it was already stopping or settled. */
  startStop(id: ThreadId, at: number): boolean {
    return this.store.atomic(
      (db) =>
        Number(
          db
            .prepare(
              "UPDATE machine_children SET stop_started_at=?, stop_attempts=0, stop_last_at=NULL WHERE id=? AND settled=0 AND stop_started_at IS NULL",
            )
            .run(at, id).changes,
        ) > 0,
    );
  }
  /** One more cancel went out at `at`. */
  stopAttempted(id: ThreadId, at: number): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE machine_children SET stop_attempts=stop_attempts+1, stop_last_at=? WHERE id=?",
        )
        .run(at, id),
    );
  }
  /** Unsettled children being stopped, by index. */
  stopping(): ChildRow[] {
    return this.all(
      "SELECT * FROM machine_children WHERE settled=0 AND stop_started_at IS NOT NULL ORDER BY stop_started_at",
    );
  }
  /**
   * Every cancel went out unconfirmed: settled here with `view`, for good. Its unanswered
   * messages are dropped (none will be taken), and the re-check window opens so a late report
   * can record how it really ended.
   */
  markStoppedUnconfirmed(id: ThreadId, view: string, now: number): void {
    this.store.atomic((db) => {
      db.prepare("DELETE FROM machine_child_messages WHERE child_id=?").run(id);
      db.prepare(
        "UPDATE machine_children SET view=?, settled=1, settled_at=?, stopped_unconfirmed=1, silent_since=NULL WHERE id=?",
      ).run(view, now, id);
    });
  }
  /** Its machine later reported how a child stopped here really ended: kept, still settled. */
  recordLateEnd(id: ThreadId, view: string): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET view=? WHERE id=? AND settled=1").run(view, id),
    );
  }
  /**
   * Its machine reported that a child stopped here without confirmation has ended: its real
   * end is kept, and its cancel stops being sent (`stopped_unconfirmed` 2: confirmed late).
   */
  confirmStop(id: ThreadId, view: string): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE machine_children SET view=?, stopped_unconfirmed=2 WHERE id=? AND settled=1 AND stopped_unconfirmed=1",
        )
        .run(view, id),
    );
  }
  /**
   * A child stopped here whose stop can never be confirmed (its pairing or its record there is
   * gone): its end is kept and its cancel stops being sent (`stopped_unconfirmed` 3).
   */
  markStopUnconfirmable(id: ThreadId, view: string): boolean {
    return this.store.atomic(
      (db) =>
        Number(
          db
            .prepare(
              "UPDATE machine_children SET view=?, stopped_unconfirmed=3 WHERE id=? AND settled=1 AND stopped_unconfirmed=1",
            )
            .run(view, id).changes,
        ) > 0,
    );
  }
  /** Children stopped here whose machine hasn't confirmed it yet: their cancel is still sent. */
  unconfirmedStops(limit: number): ChildRow[] {
    return this.all(
      "SELECT * FROM machine_children WHERE settled=1 AND stopped_unconfirmed=1 ORDER BY stop_last_at LIMIT ?",
      limit,
    );
  }
  /** New work for it: any stop before no longer applies. */
  clearStop(id: ThreadId): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE machine_children SET stop_started_at=NULL, stop_attempts=0, stop_last_at=NULL, stopped_unconfirmed=0, silent_since=NULL WHERE id=?",
        )
        .run(id),
    );
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
  /** Every settled child the re-check tracks on one machine. */
  recheckRows(machine: string): ChildRow[] {
    return this.all(`SELECT * FROM machine_children WHERE ${tracked} AND machine=?`, machine);
  }
  /**
   * Children whose answered read went out at or after their 24 h mark leave the re-check for
   * good: their re-check window closes (`settled_at` null), unless they settled again since they
   * were read, or their pairing went meanwhile (the person is asked about them; their answer, not
   * this read, decides).
   */
  endRecheck(rows: readonly { id: string; settledAt: number }[]): void {
    this.store.atomic((db) => {
      const end = db.prepare(
        "UPDATE machine_children SET settled_at=NULL WHERE id=? AND settled=1 AND settled_at=? AND lost_at IS NULL",
      );
      for (const row of rows) end.run(row.id, row.settledAt);
    });
  }
  /** Machines with a child to read: working there, or settled and still tracked. */
  watchedMachines(): string[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(`SELECT DISTINCT machine FROM machine_children WHERE settled=0 OR (${tracked})`)
          .all(),
      )
      .map((row) => z.string().parse(row.machine));
  }
  /** Every child still working on one machine, lost ones included. */
  unsettledOf(machine: string): ChildRow[] {
    return this.all("SELECT * FROM machine_children WHERE settled=0 AND machine=?", machine);
  }
  /**
   * Saves whether each child is asked alone (its call failed or was refused beside others), so
   * that outlives a restart. Kept in `rechecked`, which no longer counts re-check turns: -1 is
   * alone; anything else, including a turn number from an older build, is not.
   */
  setAlone(ids: readonly string[], alone: boolean): void {
    this.store.atomic((db) => {
      const mark = db.prepare("UPDATE machine_children SET rechecked=? WHERE id=?");
      for (const id of ids) mark.run(alone ? -1 : 0, id);
    });
  }
}

/**
 * Which settled children the re-check tracks: every one whose re-check window is still open
 * (`settled_at` set; it closes only once a check answered at or after its 24 h mark), and every
 * stop not yet confirmed. No time bound: an unreachable machine's children stay until it answers.
 * One whose machine was unpaired and that the person is asked about waits outside it until the
 * machine is paired again.
 */
const tracked =
  "settled=1 AND lost_at IS NULL AND (settled_at IS NOT NULL OR stopped_unconfirmed=1)";

/** SQLite caps bound values per statement; long id lists go in pieces. */
function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let index = 0; index < ids.length; index += 500) out.push(ids.slice(index, index + 500));
  return out;
}
