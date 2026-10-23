import { createHash } from "node:crypto";
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
import { ChildOutbox } from "./child-outbox.ts";

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
  /** Hands a settled result or a message notice to the parent; `key` names it once. */
  deliver(parentThreadId: ThreadId, key: string, text: string): void;
  /** A live wait reads this child, so its result is not woken separately. */
  waiting(id: ThreadId): boolean;
  isDescendant(child: ThreadId, ancestor: ThreadId): boolean;
  log(message: string, fields: Record<string, unknown>): void;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
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
  private outbox: ChildOutbox;
  constructor(deps: ChildrenDeps) {
    this.deps = deps;
    deps.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS machine_children (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, parent_thread TEXT NOT NULL,
        parent_agent TEXT NOT NULL, machine TEXT NOT NULL, role TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, view TEXT,
        settled INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0)`),
    );
    this.outbox = new ChildOutbox(deps.store);
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
      notice: _notice,
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
          ...(this.saved(row)?.notice ? { notice: this.saved(row)?.notice?.text } : {}),
          machine: clip(this.deps.label(row.machine), 64),
        },
      ];
    });
  }
  private saved(row: Row): MachineThreadView | undefined {
    return row.view ? MachineThreadView.parse(JSON.parse(row.view)) : undefined;
  }
  /**
   * The parent sent a settled child more work: it is working again, so the parent's tree reads
   * working until its next result arrives, and the poll watches it again.
   */
  reopen(id: ThreadId): void {
    const row = this.row(id);
    if (!row || row.settled !== 1) return;
    // The result it settled with stays owed to the parent, whatever the child does next.
    if (row.delivered === 0) this.queueResult(row, this.saved(row));
    this.deps.store.atomic((db) => {
      // Its last view showed it finished; until a poll reads it again it shows as working.
      db.prepare("UPDATE machine_children SET settled=0, delivered=0, view=NULL WHERE id=?").run(
        id,
      );
      this.deps.engine()?.machineChild(
        {
          id,
          parentId: row.parent_thread,
          parentAgentId: row.parent_agent,
          machine: row.machine,
          name: this.deps.label(row.machine),
          provider: row.provider,
          model: row.model ?? undefined,
          role: row.role,
          title: this.saved(row)?.title || row.role,
          status: { state: "working", agents: 1 },
          outcome: null,
        },
        "start",
      );
    });
    this.emit([id]);
    this.arm();
  }
  delivered(id: ThreadId): void {
    this.deps.store.atomic((db) =>
      db.prepare("UPDATE machine_children SET delivered=1 WHERE id=?").run(id),
    );
    this.outbox.resultsRead(id);
  }
  subscribe(listener: (ids: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /**
   * Polls only while a child is unsettled or a result is undelivered. A failed poll or ledger
   * read, such as a busy store, is logged and polled again.
   */
  private arm() {
    if (this.closed || this.cancelTimer) return;
    let due = true;
    try {
      due = this.rows("settled=0 OR delivered=0").length > 0 || this.outbox.hasUnsent();
    } catch (error) {
      this.deps.log("Machine children poll failed", { error });
    }
    if (!due) return;
    this.cancelTimer = this.deps.schedule(this.deps.pollMs, () => {
      this.cancelTimer = undefined;
      void this.poll()
        .catch((error: unknown) => this.deps.log("Machine children poll failed", { error }))
        .finally(() => this.arm());
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
      for (const row of this.rows("settled=1 AND delivered=0"))
        this.queueResult(row, this.saved(row));
      this.drain();
    } finally {
      this.polling = false;
    }
  }
  private update(row: Row, view: MachineThreadView) {
    this.unreachable.delete(row.id);
    if (view.notice)
      this.outbox.queue({
        key: `notice:${row.id}:${view.notice.commandId}:${view.notice.code}`,
        child: row.id,
        parent: row.parent_thread,
        kind: "notice",
        text: `[ace: ${row.role} on ${this.deps.label(row.machine)}]\n${view.notice.text}`,
      });
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
      if (settled) this.queueResult(row, view);
    });
    if (settled) this.deps.mirror.release(`child:${row.id}`);
    this.emit([row.id]);
  }
  /**
   * Owes the parent the result a settled view carries. Keyed by the outcome, its settle time and
   * its text alone, so the same settle read again (a notice changed the view, the child was
   * reopened and settled unchanged) is the same entry, while a new settle is a new one.
   */
  private queueResult(row: Row, view: MachineThreadView | undefined) {
    if (!view || !settledStates.has(view.state)) return;
    const outcome = outcomeOf(view.state);
    const result = view.result ?? "";
    this.outbox.queue({
      key: `result:${row.id}:${digest(JSON.stringify([outcome, view.elapsedSeconds, result]))}`,
      child: row.id,
      parent: row.parent_thread,
      kind: "result",
      text: `[ace: ${row.role} on ${this.deps.label(row.machine)} ${outcome}]\n${result || "No text result returned."}${view.truncated ? "\n[Result truncated.]" : ""}`,
    });
  }
  /**
   * Hands every owed result and notice to its parent, oldest first. Each is marked sent only
   * once the parent took it; one that fails waits for the next poll. A result a live wait is
   * about to read is left for that wait.
   */
  private drain() {
    for (const entry of this.outbox.unsent()) {
      if (entry.kind === "result" && this.deps.waiting(ThreadId.parse(entry.child))) continue;
      try {
        this.deps.deliver(
          ThreadId.parse(entry.parent),
          `${entry.kind}:${digest(entry.key)}`,
          entry.text,
        );
        this.outbox.sent(entry.key);
        if (entry.kind === "result")
          this.deps.store.atomic((db) =>
            db
              .prepare("UPDATE machine_children SET delivered=1 WHERE id=? AND settled=1")
              .run(entry.child),
          );
      } catch (error) {
        this.deps.log("Machine result not delivered yet", {
          id: entry.child,
          error: String(error),
        });
      }
    }
  }
  private emit(ids: readonly string[]) {
    for (const listener of this.listeners) listener(ids);
  }
}
