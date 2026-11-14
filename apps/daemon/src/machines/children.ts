import {
  ThreadId,
  type AgentId,
  type Command,
  type CommandResult,
  type DelegationOutcome,
  type HostId,
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
import { childAgentKey } from "../engine/remote-child-status.ts";
import { unreadableChild } from "../agent-control/snapshot-rows.ts";
import { clip, settledStates } from "../agent-control/watch-view.ts";
import type { RequestMirror } from "./mirror.ts";
import { ChildMessages, type Answer, type ChildMessagesDeps } from "./child-messages.ts";
import { ChildResults, type ChildResultsDeps } from "./child-results.ts";
import { queuedStatus, queuedStep } from "../agent-control/child-status.ts";
import {
  RECHECK_PER_MACHINE,
  RECHECK_POLLS,
  RECHECK_WINDOW_MS,
  recheckOutcome,
} from "./child-recheck.ts";
import { ChildLedger, savedView, type ChildRow } from "./child-ledger.ts";
import {
  heldMessageReason,
  monitoredChild,
  outcomeOf,
  unreadReason,
  watchedChild,
} from "./child-views.ts";
import { statusBatches, unsettledPage } from "./child-paging.ts";
import { LostChildren } from "./child-lost.ts";
import { RetryBackoff } from "./retry-backoff.ts";
import { ChildLiveness, type ChildLivenessDeps } from "./child-liveness.ts";

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
  /** Sends one cancel for the child to its machine; the stop sends it again until confirmed. */
  cancel(machine: string, parentThreadId: ThreadId, id: ThreadId): Promise<void>;
  /** Test overrides for the stop's attempts and the lease; the defaults are ADR 0052's. */
  stopPlan?: ChildLivenessDeps["stopPlan"];
  leaseMs?: number | undefined;
  mirror: RequestMirror;
  label(machine: string): string;
  /** The machine's host id when known, so the parent's row can name where the child lives. */
  host?(machine: string): HostId | undefined;
  deliver: ChildResultsDeps["deliver"];
  held?: ChildResultsDeps["held"] | undefined;
  /** A live wait reads this child, so its result is not woken separately. */
  waiting(id: ThreadId): boolean;
  isDescendant(child: ThreadId, ancestor: ThreadId): boolean;
  /** Every thread delegated below this one here, at any depth. */
  descendants(thread: ThreadId): readonly ThreadId[];
  /**
   * The device this machine is paired with `machine` as, or undefined once that pairing is gone.
   * Throws when the pairings can't be read, which is never taken as gone.
   */
  device(machine: string): string | undefined;
  log(message: string, fields: Record<string, unknown>): void;
}

/** At most this long between status calls to a machine that keeps failing them. */
const UNREACHABLE_RETRY_CAP_MS = 30_000;

/** The person stopped tracking this lost child: it stays settled for good (ADR 0099). */
const abandoned = (row: ChildRow) => row.settled === 1 && row.lost_at !== null;

/**
 * Delegated children that run on other machines. The ledger is durable so a restart keeps
 * watching them; a machine that can't be reached keeps its children working, never done.
 */
export class MachineChildren implements RemoteChildren {
  private deps: ChildrenDeps;
  private ledger: ChildLedger;
  private listeners = new Set<(ids: readonly string[]) => void>();
  /** Why a child's machine could not be read on the last try, until it is read again. */
  private unreachable = new Map<string, string>();
  /** Why a message to the child is still unanswered, until it is answered. */
  private held = new Map<string, string>();
  private cancelTimer: (() => void) | undefined;
  /** When the scheduled poll runs, by the injected clock. */
  private dueAt = 0;
  private polling = false;
  /** Polls since settled children were last re-checked for work started on their machine. */
  private sinceRecheck = 0;
  /** The next poll comes at the slow re-check pace, so it re-checks settled children. */
  private slowPace = false;
  /** When settled children were last re-checked, by the injected clock. */
  private lastRecheckAt = Number.NEGATIVE_INFINITY;
  /**
   * Machines whose status calls fail, each asked again later after every failure and at once
   * when another call to it gets through; logged when that starts and when it ends.
   */
  private reach: RetryBackoff;
  /** The last re-check turn handed out; each machine's least recently checked go next. */
  private turn: number;
  /** The last polling turn handed out; machines served longest ago go next. */
  private served: number;
  private closed = false;
  private results: ChildResults;
  private messages: ChildMessages;
  private lost: LostChildren;
  private liveness: ChildLiveness;
  constructor(deps: ChildrenDeps) {
    this.deps = deps;
    this.ledger = new ChildLedger(deps.store);
    this.turn = this.ledger.lastRecheckTurn();
    this.served = this.ledger.lastServedTurn();
    this.reach = new RetryBackoff(deps.pollMs, UNREACHABLE_RETRY_CAP_MS);
    this.results = new ChildResults({ ...deps, ledger: this.ledger });
    this.lost = new LostChildren({
      ...deps,
      ledger: this.ledger,
      results: this.results,
      emit: (ids) => this.emit(ids),
    });
    this.liveness = new ChildLiveness({
      ...deps,
      ledger: this.ledger,
      results: this.results,
      cancel: (row) => deps.cancel(row.machine, row.parent_thread, row.id),
      unpaired: (row) => this.lostFrom(row.machine)?.(row) ?? false,
      emit: (ids) => this.emit(ids),
    });
    this.messages = new ChildMessages({
      ...deps,
      ledger: this.ledger,
      reopenSettled: (row) => this.reopenSettled(row),
      reopen: (id) => this.reopen(id),
      changed: () => this.arm(),
      held: (row, error) => {
        if (error === undefined) this.held.delete(row.id);
        else this.held.set(row.id, heldMessageReason(this.deps.label(row.machine), error));
        this.emit([row.id]);
      },
      rejected: (row, requestId, reason) => this.results.rejected(row, requestId, reason),
    });
    this.arm();
  }
  close() {
    this.closed = true;
    this.liveness.close();
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
  byRequest(key: string): ThreadId | undefined {
    return this.ledger.byRequest(key);
  }
  child(
    id: string,
  ):
    | { machine: string; parentThreadId: ThreadId; settled: boolean; abandoned: boolean }
    | undefined {
    const row = this.ledger.row(id);
    return row
      ? {
          machine: row.machine,
          parentThreadId: row.parent_thread,
          settled: row.settled === 1,
          abandoned: abandoned(row),
        }
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
    /** The paired device it was delegated through. */
    device?: string | undefined;
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
      this.ledger.insert({ ...child, createdAt: this.deps.now(), view, device: child.device });
      this.deps.engine()?.machineChild(
        {
          id: child.id,
          parentId: child.parentThreadId,
          parentAgentId: child.parentAgentId,
          machine: child.machine,
          name: this.deps.label(child.machine),
          hostId: this.deps.host?.(child.machine),
          provider: child.provider,
          model: child.model,
          role: child.role,
          title: child.title,
          status: view?.status ?? { state: "working", agents: 1 },
          state: view?.state ?? "working",
          outcome: null,
        },
        "start",
      );
    });
    this.arm();
  }
  /**
   * Stops the child (ADR 0052): the cancel goes to its machine and again with backoff until its
   * machine reports it ended; past the last attempt it is stopped here, saying its machine never
   * confirmed. False when there is nothing left to stop.
   */
  stop(id: ThreadId): boolean {
    const stopping = this.liveness.stop(id);
    if (stopping) this.arm();
    return stopping;
  }
  /**
   * Every unsettled child delegated from this thread or below it, for a cascading stop: read by
   * parent, however many there are.
   */
  under(thread: ThreadId): ThreadId[] {
    return this.ledger.unsettledOfParents([thread, ...this.deps.descendants(thread)]);
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
      this.held.get(id) ?? this.unreachable.get(id),
      this.deps.now(),
    );
  }
  /** Every child delegated from the caller's thread or below it, unsettled first. */
  children(caller: McpAttribution): MonitoredChild[] {
    const rows = this.ledger.ofParents([
      caller.threadId,
      ...this.deps.descendants(caller.threadId),
    ]);
    return rows.map((row) => {
      const name = this.deps.label(row.machine);
      try {
        const read = watchedChild(
          row,
          name,
          this.held.get(row.id) ?? this.unreachable.get(row.id),
          this.deps.now(),
        );
        return monitoredChild(row, read.view, caller.threadId, name);
      } catch (error) {
        // A saved view this build can't read still lists the child, as unknown, never settled.
        const identity = {
          id: row.id,
          role: row.role,
          ...(row.parent_thread === caller.threadId ? {} : { parent: row.parent_thread }),
          machine: name,
        };
        const unread = unreadableChild(identity, error);
        this.deps.log("Machine child view not read", { child: row.id, problem: unread.problem });
        return unread.child;
      }
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
    // The person stopped tracking it: nothing reopens it, whatever arrives late.
    if (abandoned(row)) return;
    const { id } = row;
    // The result it settled with stays owed to the parent, whatever the child does next.
    if (row.delivered === 0) this.results.queueResult(row, savedView(row));
    this.deps.store.atomic(() => {
      // Its last view showed it finished; until a poll reads it again it shows as working.
      this.ledger.markReopened(id);
      // New work the parent sent: a stop before it no longer applies.
      this.ledger.clearStop(id);
      this.deps.engine()?.machineChild(
        {
          id,
          parentId: row.parent_thread,
          parentAgentId: row.parent_agent,
          machine: row.machine,
          name: this.deps.label(row.machine),
          hostId: this.deps.host?.(row.machine),
          provider: row.provider,
          model: row.model ?? undefined,
          role: row.role,
          title: savedView(row)?.title || row.role,
          status: { state: "working", agents: 1 },
          state: "working",
          outcome: null,
        },
        "start",
      );
    });
    this.emit([id]);
    this.arm();
  }
  /** The person's answer about a lost child (LostChildren.resolve); undefined for any other. */
  resolve(command: Command): CommandResult | undefined {
    return this.lost.resolve(command);
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
   * Polls while a child is unsettled or a message is open; while a result is owed, when it may
   * be deliverable (failed deliveries back off, a stopped parent's wait for resumed()); and at
   * the slow re-check pace while settled children are watched. A failed poll or ledger read,
   * such as a busy store, is logged and polled again.
   */
  private arm() {
    if (this.closed) return;
    const slow = this.deps.pollMs * RECHECK_POLLS;
    const now = this.deps.now();
    let delay: number | undefined = this.deps.pollMs;
    let onlySettled = false;
    try {
      if (!this.ledger.hasUnsettled() && !this.ledger.anyMessages()) {
        onlySettled = true;
        const wake = this.results.wakeAt(now);
        const waits: number[] = [];
        if (wake !== undefined) waits.push(Math.max(this.deps.pollMs, wake - now));
        if (this.ledger.hasRecentlySettled(now - RECHECK_WINDOW_MS)) waits.push(slow);
        delay = waits.length ? Math.min(...waits) : undefined;
      }
    } catch (error) {
      this.deps.log("Machine children poll failed", { error });
    }
    if (delay === undefined) return;
    // A poll already due as soon stays; new work that needs an earlier one replaces it.
    if (this.cancelTimer && this.dueAt <= now + delay) return;
    this.cancelTimer?.();
    // With only settled children watched, a poll re-checks them once the re-check pace has
    // passed, whatever brings it sooner (a retry due, say).
    this.slowPace = delay >= slow || (onlySettled && now + delay >= this.lastRecheckAt + slow);
    this.dueAt = now + delay;
    this.cancelTimer = this.deps.schedule(delay, () => {
      this.cancelTimer = undefined;
      void this.poll()
        .catch((error: unknown) => this.deps.log("Machine children poll failed", { error }))
        .finally(() => this.arm());
    });
  }
  /**
   * Something happened on this thread (new input, say): results waiting for it as a stopped
   * parent are asked about on the next poll, at most `pollMs` away. A poll already set sooner
   * stays, so a parent streaming events never pushes the poll back.
   */
  threadChanged(thread: string): void {
    if (this.closed || !this.results.resumed(thread)) return;
    this.arm();
  }
  /** Another call to the machine got through: status calls to it go on the next poll. */
  machineReachable(machine: string): void {
    this.reach.retryNow(machine);
  }
  /** A status call to the machine got through: its failure episode, if any, ends. */
  private reached(machine: string) {
    const failures = this.reach.succeeded(machine);
    if (failures > 0)
      this.deps.log("Machine children reachable again", { machine, attempts: failures + 1 });
  }
  /** A status call to the machine failed: it is asked again later, logged once per episode. */
  private unreached(machine: string, error: unknown) {
    if (this.reach.failed(machine, this.deps.now()) === 1)
      this.deps.log("Machine children unreachable", { machine, error: String(error) });
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
      // A fixed number of status calls, every child read in turn (ADR 0099).
      const page = unsettledPage(this.ledger, ++this.served).flatMap(([machine, rows]) => {
        const lost = this.lostFrom(machine);
        // Pairings that can't be read leave every child as it was, lost or not.
        if (!lost) return rows.filter((row) => row.lost_at === null);
        for (const row of rows) {
          if (lost(row)) this.lost.keep(row);
          else if (row.lost_at !== null) this.lost.found(row);
        }
        return rows.filter((row) => !lost(row));
      });
      const now = this.deps.now();
      await Promise.all([
        ...statusBatches(page).map(async ([machine, rows]) => {
          const ids = rows.map((row) => row.id);
          const first = rows[0];
          // A machine failing its calls is asked again once its wait is over.
          if (!first || !this.reach.due(machine, now)) return;
          try {
            const views = await this.deps.status(machine, first.parent_thread, ids);
            this.reached(machine);
            for (const view of views) {
              const row = rows.find((candidate) => candidate.id === view.threadId);
              if (row && !this.closed) this.update(row, view);
            }
            // A slow sibling machine must not hold a result already received from this one.
            if (!this.closed) this.results.drain();
          } catch (error) {
            this.unreached(machine, error);
            const reason = unreadReason(this.deps.label(machine), error);
            for (const id of ids) this.unreachable.set(id, reason);
            this.emit(ids);
          }
        }),
        ...this.recheckDue(now).map(async ([machine, rows]) => {
          const first = rows[0];
          if (!first) return;
          try {
            const views = await this.deps.status(
              machine,
              first.parent_thread,
              rows.map((row) => row.id),
            );
            this.reached(machine);
            for (const view of views) {
              const row = rows.find((candidate) => candidate.id === view.threadId);
              if (row && !this.closed) this.recheck(row, view);
            }
          } catch (error) {
            // A settled child stays settled while its machine can't be asked; a later
            // re-check tries again, later after each failure.
            this.unreached(machine, error);
          }
        }),
      ]);
      // Stops due, then the lease: replies read above have already renewed what reported.
      this.liveness.tick();
      this.liveness.lapse();
      for (const row of this.ledger.undelivered()) this.results.queueResult(row, savedView(row));
      this.results.drain();
    } finally {
      this.polling = false;
    }
  }
  /**
   * Settled children due a re-check, grouped by machine: every `RECHECK_POLLS` polls at the
   * ordinary pace, and on every poll at the slow re-check pace. A machine failing its calls is
   * left out until its wait is over.
   */
  private recheckDue(now: number): [string, ChildRow[]][] {
    if (!this.slowPace && ++this.sinceRecheck < RECHECK_POLLS) return [];
    this.sinceRecheck = 0;
    this.lastRecheckAt = now;
    const since = now - RECHECK_WINDOW_MS;
    const turn = ++this.turn;
    // Every machine, and on each the children checked longest ago: all are checked in turn.
    return this.ledger.recheckMachines(since).flatMap((machine) => {
      if (!this.reach.due(machine, now)) return [];
      const rows = this.ledger.recheckTurn(machine, since, RECHECK_PER_MACHINE);
      this.ledger.markRechecked(
        rows.map((row) => row.id),
        turn,
      );
      // A machine no longer paired as the child's device can't be asked about it.
      const lost = this.lostFrom(machine);
      const asked = lost ? rows.filter((row) => !lost(row)) : rows;
      return asked.length ? [[machine, asked] as [string, ChildRow[]]] : [];
    });
  }
  /**
   * Which of a machine's children this machine can no longer reach: the pairing they were
   * delegated through is gone (removed, or the machine linked again as a new device). Undefined
   * when the pairings can't be read, which is never taken as gone or as back.
   */
  private lostFrom(machine: string): ((row: ChildRow) => boolean) | undefined {
    let device: string | undefined;
    try {
      device = this.deps.device(machine);
    } catch (error) {
      this.deps.log("Machine pairings not read", { machine, error: String(error) });
      return undefined;
    }
    return (row) => device === undefined || (row.device_id !== null && row.device_id !== device);
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
      row.lost_at !== null ||
      row.generation !== polled.generation ||
      this.ledger.hasMessages(row.id)
    )
      return;
    // Stopped here without confirmation: its real end is recorded, but it never comes back.
    if (row.stopped_unconfirmed !== 0)
      return this.liveness.late(
        row,
        view,
        settledStates.has(view.state) && view.requests.length === 0,
      );
    const outcome = recheckOutcome(savedView(row), view);
    if (outcome === "ignore") return;
    if (outcome === "reopen") this.reopenSettled(row);
    const current = this.ledger.row(row.id);
    if (current) this.update(current, view);
  }
  /** Applies a status reply read under `polled`; one from before newer work is dropped. */
  private update(polled: ChildRow, view: MachineThreadView) {
    const current = this.ledger.row(polled.id);
    if (!current || current.generation !== polled.generation) return;
    // A reply read before its pairing went is never applied to a lost or abandoned child.
    if (current.lost_at !== null) return;
    // Any reply is proof of life, even one that changes nothing else.
    const row = this.liveness.seen(current);
    if (this.ledger.hasMessages(row.id)) return;
    this.unreachable.delete(row.id);
    if (view.notice) this.results.notice(row, view.notice);
    const settled = settledStates.has(view.state) && view.requests.length === 0;
    const text = JSON.stringify(view);
    const name = this.deps.label(row.machine);
    // Being stopped: its requests are no longer the person's to answer, and only its end counts.
    if (this.liveness.stopping(row) && !settled) {
      if (text !== row.view) this.ledger.writeView(row.id, text, false, this.deps.now());
      return;
    }
    this.deps.mirror.sync(`child:${row.id}`, row.parent_thread, row.machine, name, view.requests, {
      agent: childAgentKey(row.id),
    });
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
          hostId: this.deps.host?.(row.machine),
          provider: row.provider,
          model: row.model ?? undefined,
          role: row.role,
          title: view.title || row.role,
          status: view.status,
          state: view.state,
          outcome: settled
            ? {
                threadId: row.id,
                outcome: outcomeOf(view.state),
                ...(view.failure ? { failure: view.failure } : {}),
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
