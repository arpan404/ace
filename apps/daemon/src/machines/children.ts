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
import { ChildOutbox } from "./child-outbox.ts";
import { queuedStatus, queuedStep } from "../agent-control/child-status.ts";
import {
  RECHECK_PER_MACHINE,
  RECHECK_POLLS,
  RECHECK_WINDOW_MS,
  recheckOutcome,
} from "./child-recheck.ts";
import { ChildLedger, savedView, type ChildRow } from "./child-ledger.ts";
import { digest, monitoredChild, outcomeOf, watchedChild } from "./child-views.ts";

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
  /**
   * Sends a message again under its own request id, which the machine runs at most once.
   * "taken" or "refused" answers for it; a machine that can't be reached throws.
   */
  resend(
    machine: string,
    parentThreadId: ThreadId,
    child: ThreadId,
    message: MachineMessage,
  ): Promise<"taken" | "refused">;
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
  /** Messages this process is sending now, by child and request id: not sent again meanwhile. */
  private inFlight = new Set<string>();
  private closed = false;
  private outbox: ChildOutbox;
  constructor(deps: ChildrenDeps) {
    this.deps = deps;
    this.ledger = new ChildLedger(deps.store);
    this.recheckTurn = this.ledger.lastRecheckTurn();
    this.outbox = new ChildOutbox(deps.store);
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
    if (row.delivered === 0) this.queueResult(row, savedView(row));
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
  /**
   * New work is on its way to the child. It is saved first, with the child reopened, so a caller
   * that stops before the reply finds it open and the message unanswered. Until its machine
   * answers for the message no status reply settles the child, and replies read before now never
   * will. The returned release says whether the machine answered for it (took it, refused it, or
   * was never reached); an unanswered message is sent again on the next poll.
   */
  send(id: ThreadId, message: MachineMessage): (answered: boolean) => void {
    const key = `${id}:${message.requestId}`;
    this.deps.store.atomic(() => {
      this.ledger.addMessage(id, message, this.deps.now());
      const row = this.ledger.row(id);
      if (row?.settled === 1) this.reopenSettled(row);
    });
    this.inFlight.add(key);
    let released = false;
    return (answered) => {
      if (released) return;
      released = true;
      this.inFlight.delete(key);
      if (answered) this.resolve(id, message.requestId);
      this.arm();
    };
  }
  /**
   * The machine answered for a message. Should saving that fail (a busy store), the message stays
   * unanswered and the next poll sends it again, which its machine answers without running it twice.
   */
  private resolve(id: ThreadId, requestId: string): void {
    try {
      this.ledger.resolveMessage(id, requestId);
    } catch (error) {
      this.deps.log("Machine message answer not saved yet", { id, error: String(error) });
    }
  }
  /**
   * Sends every unanswered message not being sent now again, under its own request id. An answer
   * proves the machine holds the message (it runs, or ran) or refused it; one that can't be
   * reached keeps it unanswered, and its child unsettled.
   */
  private async reconcile(): Promise<void> {
    const pending = this.ledger
      .messages(16)
      .filter(({ child, message }) => !this.inFlight.has(`${child.id}:${message.requestId}`));
    await Promise.all(
      pending.map(async ({ child, message }) => {
        const key = `${child.id}:${message.requestId}`;
        this.inFlight.add(key);
        try {
          const answer = await this.deps.resend(
            child.machine,
            child.parent_thread,
            child.id,
            message,
          );
          this.resolve(child.id, message.requestId);
          if (answer === "taken") this.reopen(child.id);
        } catch (error) {
          this.deps.log("Machine message still unanswered", { id: child.id, error: String(error) });
        } finally {
          this.inFlight.delete(key);
          this.arm();
        }
      }),
    );
  }
  delivered(id: ThreadId): void {
    this.ledger.markDelivered(id);
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
    let watchingSettled = false;
    try {
      due =
        this.ledger.rows("settled=0 OR delivered=0").length > 0 ||
        this.outbox.hasUnsent() ||
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
      void this.reconcile().catch((error: unknown) =>
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
        this.queueResult(row, savedView(row));
      this.drain();
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
  private queueResult(row: ChildRow, view: MachineThreadView | undefined) {
    if (!view || !settledStates.has(view.state)) return;
    const outcome = outcomeOf(view.state);
    const result = view.result ?? "";
    const key = `result:${row.id}:${digest(JSON.stringify([outcome, view.elapsedSeconds, result]))}`;
    // The same settle read again after a reopen that ran nothing: its parent already has it, so
    // it is delivered again in the ledger only, and the poll can go quiet.
    if (this.outbox.wasSent(key)) return this.ledger.markResultDelivered(row.id);
    this.outbox.queue({
      key,
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
        if (entry.kind === "result") this.ledger.markResultDelivered(entry.child);
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
