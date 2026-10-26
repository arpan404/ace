import {
  ThreadId,
  type AgentId,
  type DelegationOutcome,
  type MachineMessage,
  type MachineThreadView,
  type McpAttribution,
  type MonitoredChild,
  type ProviderKind,
  type WatchedThread,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import type { RemoteChildren } from "../agent-control/monitor.ts";
import { clip, settledStates } from "../agent-control/watch-view.ts";
import type { RequestMirror } from "./mirror.ts";
import { MachineFailure } from "./transport.ts";
import { ChildMessages, type Answer, type ChildMessagesDeps } from "./child-messages.ts";
import { ChildResults } from "./child-results.ts";
import { queuedStatus, queuedStep } from "../agent-control/child-status.ts";
import {
  RECHECK_PER_MACHINE,
  RECHECK_POLLS,
  RECHECK_WINDOW_MS,
  recheckOutcome,
} from "./child-recheck.ts";
import { ChildLedger, savedView, type ChildRow } from "./child-ledger.ts";
import { monitoredChild, outcomeOf, watchedChild } from "./child-views.ts";

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
  resend: ChildMessagesDeps["resend"];
  mirror: RequestMirror;
  label(machine: string): string;
  /** Hands a settled result or a message notice to the parent; `key` names it once. */
  deliver(parentThreadId: ThreadId, key: string, text: string): void;
  /** A live wait reads this child, so its result is not woken separately. */
  waiting(id: ThreadId): boolean;
  isDescendant(child: ThreadId, ancestor: ThreadId): boolean;
  log(message: string, fields: Record<string, unknown>): void;
}

/**
 * Unsettled children grouped by machine, at most 16 per status call (the call's limit), so
 * every one is read on every poll rather than the same first 16.
 */
function statusBatches(rows: readonly ChildRow[]): [string, ChildRow[]][] {
  const batches: [string, ChildRow[]][] = [];
  const open = new Map<string, ChildRow[]>();
  for (const row of rows) {
    let batch = open.get(row.machine);
    if (!batch || batch.length >= 16) {
      batch = [];
      open.set(row.machine, batch);
      batches.push([row.machine, batch]);
    }
    batch.push(row);
  }
  return batches;
}

/**
 * Delegated children that run on other machines. The ledger is durable so a restart keeps
 * watching them; a machine that can't be reached keeps its children working, never done.
 */
export class MachineChildren implements RemoteChildren {
  private deps: ChildrenDeps;
  private ledger: ChildLedger;
  private listeners = new Set<(ids: readonly string[]) => void>();
  private unreachable = new Map<string, string>();
  private cancelTimer: (() => void) | undefined;
  private polling = false;
  /** Polls since settled children were last re-checked for work started on their machine. */
  private sinceRecheck = 0;
  /** The last re-check turn handed out; each machine's least recently checked go next. */
  private recheckTurn: number;
  private closed = false;
  private results: ChildResults;
  private messages: ChildMessages;
  constructor(deps: ChildrenDeps) {
    this.deps = deps;
    this.ledger = new ChildLedger(deps.store);
    this.recheckTurn = this.ledger.lastRecheckTurn();
    this.results = new ChildResults({ ...deps, ledger: this.ledger });
    this.messages = new ChildMessages({
      ...deps,
      ledger: this.ledger,
      reopenSettled: (row) => this.reopenSettled(row),
      reopen: (id) => this.reopen(id),
      changed: () => this.arm(),
    });
    this.arm();
  }
  close() {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
  byRequest(key: string): ThreadId | undefined {
    return this.ledger.byRequest(key);
  }
  child(id: string): { machine: string; parentThreadId: ThreadId; settled: boolean } | undefined {
    const row = this.ledger.row(id);
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
    /** The other machine queued it for a slot: it reads as queued until a poll says more. */
    queued?: boolean;
  }) {
    const view: MachineThreadView | undefined = child.queued
      ? {
          threadId: child.id,
          state: "queued",
          title: clip(child.title, 120),
          elapsedSeconds: 0,
          step: queuedStep,
          status: queuedStatus,
          requests: [],
        }
      : undefined;
    this.deps.store.atomic(() => {
      this.ledger.insert({ ...child, createdAt: this.deps.now(), view });
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
          status: view?.status ?? { state: "working", agents: 1 },
          outcome: null,
        },
        "start",
      );
    });
    this.arm();
  }
  /** Unsettled children delegated from this thread or below it, for a cascading stop. */
  under(thread: ThreadId): ThreadId[] {
    return this.ledger
      .rows("settled=0")
      .filter(
        (row) => row.parent_thread === thread || this.deps.isDescendant(row.parent_thread, thread),
      )
      .map((row) => row.id);
  }
  owns(caller: McpAttribution, id: ThreadId): boolean {
    const row = this.ledger.row(id);
    return (
      !!row &&
      (row.parent_thread === caller.threadId ||
        this.deps.isDescendant(row.parent_thread, caller.threadId))
    );
  }
  watched(id: ThreadId): { view: WatchedThread; outcome?: DelegationOutcome } | undefined {
    const row = this.ledger.row(id);
    if (!row) return undefined;
    return watchedChild(
      row,
      this.deps.label(row.machine),
      this.unreachable.get(id),
      this.deps.now(),
    );
  }
  children(caller: McpAttribution): MonitoredChild[] {
    return this.ledger.rows("1=1").flatMap((row) => {
      if (
        row.parent_thread !== caller.threadId &&
        !this.deps.isDescendant(row.parent_thread, caller.threadId)
      )
        return [];
      const read = this.watched(row.id);
      if (!read) return [];
      return [monitoredChild(row, read.view, caller.threadId, this.deps.label(row.machine))];
    });
  }
  /**
   * The parent sent a settled child more work: it is working again, so the parent's tree reads
   * working until its next result arrives, and the poll watches it again.
   */
  reopen(id: ThreadId): void {
    // Any status reply already on its way describes the child before this work.
    this.ledger.advance(id);
    const row = this.ledger.row(id);
    if (row?.settled === 1) this.reopenSettled(row);
  }
  /** A settled child is working again: saved first, so the parent reads it open even after a crash. */
  private reopenSettled(row: ChildRow): void {
    const { id } = row;
    // The result it settled with stays owed to the parent, whatever the child does next.
    if (row.delivered === 0) this.results.queueResult(row, savedView(row));
    this.deps.store.atomic(() => {
      // Its last view showed it finished; until a poll reads it again it shows as working.
      this.ledger.markReopened(id);
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
          title: savedView(row)?.title || row.role,
          status: { state: "working", agents: 1 },
          outcome: null,
        },
        "start",
      );
    });
    this.emit([id]);
    this.arm();
  }
  /** New work is on its way to the child; see ChildMessages.send. */
  send(id: ThreadId, message: MachineMessage): (answer: Answer | undefined) => void {
    return this.messages.send(id, message);
  }
  delivered(id: ThreadId): void {
    this.results.read(id);
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
    let watchingSettled = false;
    try {
      due =
        this.ledger.rows("settled=0 OR delivered=0").length > 0 ||
        this.results.hasUnsent() ||
        this.ledger.anyMessages();
      watchingSettled = !due && this.ledger.hasRecentlySettled(this.deps.now() - RECHECK_WINDOW_MS);
    } catch (error) {
      this.deps.log("Machine children poll failed", { error });
    }
    if (!due && !watchingSettled) return;
    // With only settled children to re-check, the poll comes at the slower re-check pace.
    const delay = due ? this.deps.pollMs : this.deps.pollMs * RECHECK_POLLS;
    this.cancelTimer = this.deps.schedule(delay, () => {
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
      // Alongside the poll, never ahead of it: a machine slow to answer one message must not
      // stop its children being watched.
      void this.messages
        .reconcile()
        .catch((error: unknown) =>
          this.deps.log("Machine messages not reconciled yet", { error: String(error) }),
        );
      const active = this.ledger.rows("settled=0");
      await Promise.all([
        ...statusBatches(active).map(async ([machine, rows]) => {
          const ids = rows.map((row) => row.id);
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
        ...this.recheckDue(active.length > 0).map(async ([machine, rows]) => {
          const first = rows[0];
          if (!first) return;
          try {
            const views = await this.deps.status(
              machine,
              first.parent_thread,
              rows.map((row) => row.id),
            );
            for (const view of views) {
              const row = rows.find((candidate) => candidate.id === view.threadId);
              if (row && !this.closed) this.recheck(row, view);
            }
          } catch (error) {
            // A settled child stays settled while its machine can't be asked; the next
            // re-check tries again.
            this.deps.log("Machine children re-check failed", { error });
          }
        }),
      ]);
      for (const row of this.ledger.rows("settled=1 AND delivered=0"))
        this.results.queueResult(row, savedView(row));
      this.results.drain();
    } finally {
      this.polling = false;
    }
  }
  /**
   * Settled children due a re-check, grouped by machine: every `RECHECK_POLLS` polls while
   * others are watched, and on every poll once only settled ones are, as those polls already
   * come at the slower pace.
   */
  private recheckDue(watchingUnsettled: boolean): [string, ChildRow[]][] {
    if (watchingUnsettled && ++this.sinceRecheck < RECHECK_POLLS) return [];
    this.sinceRecheck = 0;
    const since = this.deps.now() - RECHECK_WINDOW_MS;
    const turn = ++this.recheckTurn;
    // Every machine, and on each the children checked longest ago: all are checked in turn.
    return this.ledger.recheckMachines(since).flatMap((machine) => {
      const rows = this.ledger.recheckTurn(machine, since, RECHECK_PER_MACHINE);
      this.ledger.markRechecked(
        rows.map((row) => row.id),
        turn,
      );
      return rows.length ? [[machine, rows] as [string, ChildRow[]]] : [];
    });
  }
  /**
   * A settled child re-read: work started on its machine reopens it, so its parent reads it
   * running and waits again; a different result from that work reaches the parent.
   */
  private recheck(polled: ChildRow, view: MachineThreadView) {
    const row = this.ledger.row(polled.id);
    if (
      !row ||
      row.settled !== 1 ||
      row.generation !== polled.generation ||
      this.ledger.hasMessages(row.id)
    )
      return;
    const outcome = recheckOutcome(savedView(row), view);
    if (outcome === "ignore") return;
    if (outcome === "reopen") this.reopenSettled(row);
    const current = this.ledger.row(row.id);
    if (current) this.update(current, view);
  }
  /** Applies a status reply read under `polled`; one from before newer work is dropped. */
  private update(polled: ChildRow, view: MachineThreadView) {
    const row = this.ledger.row(polled.id);
    if (!row || row.generation !== polled.generation || this.ledger.hasMessages(row.id)) return;
    this.unreachable.delete(row.id);
    if (view.notice) this.results.notice(row, view.notice);
    const settled = settledStates.has(view.state) && view.requests.length === 0;
    const text = JSON.stringify(view);
    const name = this.deps.label(row.machine);
    this.deps.mirror.sync(`child:${row.id}`, row.parent_thread, row.machine, name, view.requests);
    if (text === row.view && !settled) return;
    this.deps.store.atomic(() => {
      // Each settle starts the window in which work started there is still noticed.
      this.ledger.writeView(row.id, text, settled, this.deps.now());
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
      if (settled) this.results.queueResult(row, view);
    });
    if (settled) this.deps.mirror.release(`child:${row.id}`);
    this.emit([row.id]);
  }
  private emit(ids: readonly string[]) {
    for (const listener of this.listeners) listener(ids);
  }
}
