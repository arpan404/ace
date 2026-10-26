import { z } from "zod";
import { AgentId, MachineThreadView, ProviderKind, ThreadId } from "@ace/protocol";
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
  /** Messages to it on their way; no status reply settles it meanwhile. */
  sending: z.number(),
  settled_at: z.number().nullable(),
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
  rows(where: string, ...values: (string | number)[]): ChildRow[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(`SELECT * FROM machine_children WHERE ${where} ORDER BY created_at LIMIT 64`)
          .all(...values),
      )
      .map((raw) => ChildRow.parse(raw));
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
  }): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT INTO machine_children (id,request_key,parent_thread,parent_agent,machine,role,provider,model,created_at,view) VALUES (?,?,?,?,?,?,?,?,?,?)",
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
        ),
    );
  }
  /** Status replies read before now no longer apply to the child. */
  advance(id: ThreadId): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET generation=generation+1 WHERE id=?").run(id),
    );
  }
  /** A message to the child is on its way. */
  beginSend(id: ThreadId): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "UPDATE machine_children SET generation=generation+1, sending=sending+1 WHERE id=?",
        )
        .run(id),
    );
  }
  /** A message to the child was answered or given up on. */
  endSend(id: ThreadId): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET sending=MAX(sending-1,0) WHERE id=?").run(id),
    );
  }
  /** Sends a restart cut short are no longer on their way. */
  clearSends(): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET sending=0 WHERE sending>0").run(),
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
  /** Children settled at or after `since`, most recent first; an indexed read. */
  recentlySettled(since: number, limit: number): ChildRow[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT * FROM machine_children WHERE settled=1 AND settled_at>=? ORDER BY settled_at DESC LIMIT ?",
          )
          .all(since, limit),
      )
      .map((raw) => ChildRow.parse(raw));
  }
}
