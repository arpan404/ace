import { z } from "zod";
import {
  AgentId,
  MachineThreadView,
  ProviderKind,
  ThreadId,
  type DelegationOutcome,
  type McpAttribution,
  type MonitoredChild,
  type WatchedThread,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import type { RemoteChildren } from "../agent-control/monitor.ts";
import { clip, elapsedSeconds, settledStates } from "../agent-control/watch-view.ts";
import type { RequestMirror } from "./mirror.ts";
import { MachineFailure } from "./transport.ts";

const Row = z.object({
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
});
type Row = z.infer<typeof Row>;
export interface ChildrenDeps {
  store: Store;
  engine(): Engine | undefined;
  now(): number;
  /** Polls are timers the shell owns; the ledger itself never reaches for a clock. */
  schedule(ms: number, run: () => void): () => void;
  pollMs: number;
  status(
    machine: string,
    parentThreadId: ThreadId,
    ids: readonly ThreadId[],
  ): Promise<MachineThreadView[]>;
  mirror: RequestMirror;
  label(machine: string): string;
  /** Hands a settled result to the parent as a new turn. */
  deliver(parentThreadId: ThreadId, id: ThreadId, text: string): void;
  /** A live ace_wait reads this child, so its result is not woken separately. */
  waiting(id: ThreadId): boolean;
  isDescendant(child: ThreadId, ancestor: ThreadId): boolean;
  log(message: string, fields: Record<string, unknown>): void;
}
const outcomeOf = (state: WatchedThread["state"]): DelegationOutcome["outcome"] =>
  state === "done" ? "completed" : state === "cancelled" ? "cancelled" : "failed";

/**
 * Delegated children that run on other machines. The ledger is durable so a restart keeps
 * watching them; a machine that can't be reached keeps its children working, never done.
 */
export class MachineChildren implements RemoteChildren {
  private deps: ChildrenDeps;
  private listeners = new Set<(ids: readonly string[]) => void>();
  private unreachable = new Map<string, string>();
  private cancelTimer: (() => void) | undefined;
  private polling = false;
  private closed = false;
  constructor(deps: ChildrenDeps) {
    this.deps = deps;
    deps.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS machine_children (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, parent_thread TEXT NOT NULL,
        parent_agent TEXT NOT NULL, machine TEXT NOT NULL, role TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, view TEXT,
        settled INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0)`),
    );
    this.arm();
  }
  close() {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
  private row(id: string): Row | undefined {
    const raw = this.deps.store.atomic((db) =>
      db.prepare("SELECT * FROM machine_children WHERE id=?").get(id),
    );
    return raw ? Row.parse(raw) : undefined;
  }
  private rows(where: string, ...values: (string | number)[]): Row[] {
    return this.deps.store
      .atomic((db) =>
        db
          .prepare(`SELECT * FROM machine_children WHERE ${where} ORDER BY created_at LIMIT 64`)
          .all(...values),
      )
      .map((raw) => Row.parse(raw));
  }
  byRequest(key: string): ThreadId | undefined {
    const raw = this.deps.store.atomic((db) =>
      db.prepare("SELECT id FROM machine_children WHERE request_key=?").get(key),
    );
    return raw ? ThreadId.parse(raw.id) : undefined;
  }
  child(id: string): { machine: string; parentThreadId: ThreadId; settled: boolean } | undefined {
    const row = this.row(id);
    return row
      ? { machine: row.machine, parentThreadId: row.parent_thread, settled: row.settled === 1 }
      : undefined;
  }
  add(child: {
    id: ThreadId;
    requestKey: string;
    parentThreadId: ThreadId;
    parentAgentId: AgentId;
    machine: string;
    role: string;
    provider: ProviderKind;
    model?: string | undefined;
    title: string;
  }) {
    this.deps.store.atomic((db) => {
      db.prepare(
        "INSERT INTO machine_children (id,request_key,parent_thread,parent_agent,machine,role,provider,model,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        child.id,
        child.requestKey,
        child.parentThreadId,
        child.parentAgentId,
        child.machine,
        child.role,
        child.provider,
        child.model ?? null,
        this.deps.now(),
      );
      this.deps.engine()?.machineChild(
        {
          id: child.id,
          parentId: child.parentThreadId,
          parentAgentId: child.parentAgentId,
          machine: child.machine,
          name: this.deps.label(child.machine),
          provider: child.provider,
          model: child.model,
          role: child.role,
          title: child.title,
          status: { state: "working", agents: 1 },
          outcome: null,
        },
        "start",
      );
    });
    this.arm();
  }
  /** Unsettled children delegated from this thread or below it, for a cascading stop. */
  under(thread: ThreadId): ThreadId[] {
    return this.rows("settled=0")
      .filter(
        (row) => row.parent_thread === thread || this.deps.isDescendant(row.parent_thread, thread),
      )
      .map((row) => row.id);
  }
  owns(caller: McpAttribution, id: ThreadId): boolean {
    const row = this.row(id);
    return (
      !!row &&
      (row.parent_thread === caller.threadId ||
        this.deps.isDescendant(row.parent_thread, caller.threadId))
    );
  }
  watched(id: ThreadId): { view: WatchedThread; outcome?: DelegationOutcome } | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    const name = this.deps.label(row.machine);
    const saved = row.view ? MachineThreadView.parse(JSON.parse(row.view)) : undefined;
    const {
      status: _status,
      requests: _requests,
      ...view
    } = saved ?? {
      threadId: id,
      state: "working" as const,
      title: clip(row.role, 120),
      elapsedSeconds: elapsedSeconds(row.created_at, this.deps.now()),
      status: { state: "working" as const, agents: 1 },
      requests: [],
    };
    const unreachable = this.unreachable.get(id);
    const shown: WatchedThread = {
      ...view,
      machine: name,
      ...(unreachable && !settledStates.has(view.state) ? { step: unreachable } : {}),
    };
    if (row.settled !== 1) return { view: shown };
    return {
      view: shown,
      outcome: {
        threadId: id,
        outcome: outcomeOf(view.state),
        result: view.result ?? "",
        truncated: view.truncated ?? false,
        before: null,
      },
    };
  }
  children(caller: McpAttribution): MonitoredChild[] {
    return this.rows("1=1").flatMap((row) => {
      if (
        row.parent_thread !== caller.threadId &&
        !this.deps.isDescendant(row.parent_thread, caller.threadId)
      )
        return [];
      const read = this.watched(row.id);
      if (!read) return [];
      const { view } = read;
      return [
        {
          id: row.id,
          ...(row.parent_thread === caller.threadId ? {} : { parent: row.parent_thread }),
          role: clip(row.role, 40),
          state: view.state,
          ...(view.step ? { step: clip(view.step, 60) } : {}),
          elapsedSeconds: view.elapsedSeconds,
          ...(view.needs?.[0]
            ? { needs: view.needs.length, ask: clip(view.needs[0].prompt, 100) }
            : {}),
          ...(view.last ? { last: clip(view.last, 100) } : {}),
          machine: clip(this.deps.label(row.machine), 64),
        },
      ];
    });
  }
  delivered(id: ThreadId): void {
    this.deps.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET delivered=1 WHERE id=?").run(id),
    );
  }
  subscribe(listener: (ids: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Polls only while a child is unsettled or a result is undelivered. */
  private arm() {
    if (this.closed || this.cancelTimer || !this.rows("settled=0 OR delivered=0").length) return;
    this.cancelTimer = this.deps.schedule(this.deps.pollMs, () => {
      this.cancelTimer = undefined;
      void this.poll().finally(() => this.arm());
    });
  }
  async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const active = this.rows("settled=0");
      const byMachine = new Map<string, Row[]>();
      for (const row of active)
        byMachine.set(row.machine, [...(byMachine.get(row.machine) ?? []), row]);
      await Promise.all(
        [...byMachine].map(async ([machine, rows]) => {
          const ids = rows.slice(0, 16).map((row) => row.id);
          const first = rows[0];
          if (!first) return;
          try {
            const views = await this.deps.status(machine, first.parent_thread, ids);
            for (const view of views) {
              const row = rows.find((candidate) => candidate.id === view.threadId);
              if (row && !this.closed) this.update(row, view);
            }
          } catch (error) {
            const reason =
              error instanceof MachineFailure && error.kind === "refused"
                ? `${this.deps.label(machine)} stopped letting agents in`
                : `${this.deps.label(machine)} is unreachable; retrying`;
            for (const id of ids) this.unreachable.set(id, reason);
            this.emit(ids);
          }
        }),
      );
      for (const row of this.rows("settled=1 AND delivered=0")) this.deliver(row);
    } finally {
      this.polling = false;
    }
  }
  private update(row: Row, view: MachineThreadView) {
    this.unreachable.delete(row.id);
    const settled = settledStates.has(view.state) && view.requests.length === 0;
    const text = JSON.stringify(view);
    const name = this.deps.label(row.machine);
    this.deps.mirror.sync(`child:${row.id}`, row.parent_thread, row.machine, name, view.requests);
    if (text === row.view && !settled) return;
    this.deps.store.atomic((db) => {
      db.prepare("UPDATE machine_children SET view=?, settled=? WHERE id=?").run(
        text,
        settled ? 1 : 0,
        row.id,
      );
      this.deps.engine()?.machineChild(
        {
          id: row.id,
          parentId: row.parent_thread,
          parentAgentId: row.parent_agent,
          machine: row.machine,
          name,
          provider: row.provider,
          model: row.model ?? undefined,
          role: row.role,
          title: view.title || row.role,
          status: view.status,
          outcome: settled
            ? {
                threadId: row.id,
                outcome: outcomeOf(view.state),
                result: view.result ?? "",
                truncated: view.truncated ?? false,
                before: null,
              }
            : null,
        },
        settled ? "end" : undefined,
      );
    });
    if (settled) this.deps.mirror.release(`child:${row.id}`);
    this.emit([row.id]);
  }
  private deliver(row: Row) {
    if (this.deps.waiting(row.id)) return;
    const read = this.watched(row.id);
    if (!read?.outcome) return;
    const name = this.deps.label(row.machine);
    try {
      this.deps.deliver(
        row.parent_thread,
        row.id,
        `[ace: ${row.role} on ${name} ${read.outcome.outcome}]\n${read.outcome.result || "No text result returned."}${read.outcome.truncated ? "\n[Result truncated.]" : ""}`,
      );
      this.delivered(row.id);
    } catch (error) {
      this.deps.log("Machine result not delivered yet", { id: row.id, error: String(error) });
    }
  }
  private emit(ids: readonly string[]) {
    for (const listener of this.listeners) listener(ids);
  }
}
