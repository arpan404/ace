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
import { RECHECK_SLOWEST_POLLS, RECHECK_WINDOW_MS, recheckOutcome } from "./child-recheck.ts";
import {
  asksAlone,
  defaultScheduleConfig,
  foldCall,
  nextDue,
  planTurn,
  restored,
  retryNow,
  type CallOutcome,
  type ChildRecord,
  type ScheduleChild,
  type ScheduleConfig,
} from "./child-schedule.ts";
import { ChildLedger, savedView, type ChildRow } from "./child-ledger.ts";
import {
  heldMessageReason,
  monitoredChild,
  outcomeOf,
  unreadReason,
  watchedChild,
} from "./child-views.ts";
import { LostChildren } from "./child-lost.ts";
import { RetryBackoff } from "./retry-backoff.ts";
import { ChildLiveness, type ChildLivenessDeps } from "./child-liveness.ts";
import { refusedNotFound } from "./transport.ts";

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

/**
 * The person stopped tracking this lost child: it stays settled for good (ADR 0099). A settled
 * child whose machine was unpaired, still waiting on the person's answer, keeps its re-check
 * window (`settled_at`) and is not abandoned yet.
 */
const abandoned = (row: ChildRow) =>
  row.settled === 1 && row.lost_at !== null && row.settled_at === null;

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
  /**
   * Machines whose status calls fail, logged when that starts and when it ends. Which child is
   * asked when is the scheduler's (child-schedule.ts), not this.
   */
  private reach: RetryBackoff;
  /** What the scheduler remembers of each machine's children; lost on restart but `alone`. */
  private records = new Map<string, Map<string, ChildRecord>>();
  private schedule: ScheduleConfig;
  private closed = false;
  private results: ChildResults;
  private messages: ChildMessages;
  private lost: LostChildren;
  private liveness: ChildLiveness;
  constructor(deps: ChildrenDeps) {
    this.deps = deps;
    this.ledger = new ChildLedger(deps.store);
    this.schedule = defaultScheduleConfig(deps.pollMs, deps.now());
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
    const now = this.deps.now();
    let delay: number | undefined = this.deps.pollMs;
    try {
      if (!this.ledger.hasUnsettled() && !this.ledger.anyMessages()) {
        const waits: number[] = [];
        const wake = this.results.wakeAt(now);
        if (wake !== undefined) waits.push(Math.max(this.deps.pollMs, wake - now));
        // The earliest any settled child there is due a re-check, by the scheduler.
        for (const machine of this.ledger.watchedMachines()) {
          const lost = this.lostFrom(machine);
          if (!lost) continue;
          const { children } = this.childrenOf(machine, lost);
          const at = nextDue(children, this.recordsOf(machine, children), now, this.schedule);
          if (at !== undefined) waits.push(Math.max(this.deps.pollMs, at - now));
        }
        // A settled child waiting on its machine to be paired again: looked at every slow
        // interval, with no call to any machine.
        if (this.ledger.settledLost().length > 0)
          waits.push(this.deps.pollMs * RECHECK_SLOWEST_POLLS);
        delay = waits.length ? Math.min(...waits) : undefined;
      }
    } catch (error) {
      this.deps.log("Machine children poll failed", { error });
    }
    if (delay === undefined) return;
    // A poll already due as soon stays; new work that needs an earlier one replaces it.
    if (this.cancelTimer && this.dueAt <= now + delay) return;
    this.cancelTimer?.();
    this.dueAt = now + delay;
    const scheduledFor = now + delay;
    this.cancelTimer = this.deps.schedule(delay, () => {
      this.cancelTimer = undefined;
      // A poll still running a poll from now (a slow call) never holds up the next: the next is
      // set then, so one machine slow to answer never delays another's turn.
      const watchdog = this.deps.schedule(this.deps.pollMs, () => this.arm());
      void this.poll(scheduledFor)
        .catch((error: unknown) => this.deps.log("Machine children poll failed", { error }))
        .finally(() => {
          watchdog();
          this.arm();
        });
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
  /** Another call to the machine got through: children waiting out a failure go next poll. */
  machineReachable(machine: string): void {
    this.reach.retryNow(machine);
    const records = this.records.get(machine);
    if (records) this.records.set(machine, retryNow(records, this.deps.now()));
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
  /**
   * One turn for every machine with children to read: the scheduler picks which children go in
   * which calls (child-schedule.ts); the calls run at once, each on its own deadline, and each
   * answer is applied as soon as it arrives. Children asked in a turn still running are skipped,
   * so a poll never waits on a slow call, and polls can overlap.
   */
  async poll(scheduledFor?: number): Promise<void> {
    if (this.closed) return;
    // Alongside the poll, never ahead of it: a machine slow to answer one message must not
    // stop its children being watched.
    void this.messages
      .reconcile()
      .catch((error: unknown) =>
        this.deps.log("Machine messages not reconciled yet", { error: String(error) }),
      );
    // Settled children whose machine was unpaired: watched again once it is paired back.
    this.settledLost();
    const now = this.deps.now();
    const calls: Promise<void>[] = [];
    for (const machine of this.ledger.watchedMachines()) {
      // Pairings that can't be read leave every child as it was, lost or not.
      const lost = this.lostFrom(machine);
      if (!lost) continue;
      const { children, rows } = this.childrenOf(machine, lost);
      // A poll set for a child's due time asks it then, even if its timer ran a moment early.
      const plan = planTurn(
        children,
        this.recordsOf(machine, children),
        now,
        this.schedule,
        scheduledFor,
      );
      this.records.set(machine, plan.records);
      // A settled child past its 24 h mark whose machine is unpaired can't be watched through
      // its window any more: the person is asked, as for a working child whose pairing went.
      for (const id of plan.unpairedExpired) {
        const row = rows.get(id);
        if (row) this.lost.keepSettled(row);
      }
      for (const ids of plan.calls) calls.push(this.ask(machine, children, rows, ids));
    }
    await Promise.all(calls);
    // Stops due, then the lease: replies read above have already renewed what reported.
    this.liveness.tick();
    this.liveness.lapse();
    for (const row of this.ledger.undelivered()) this.results.queueResult(row, savedView(row));
    this.results.drain();
  }
  /**
   * A machine's children as the scheduler sees them: every working child (lost ones are handed
   * to the lost-child handling here, as each poll does), and every settled child still tracked.
   */
  private childrenOf(machine: string, lost: (row: ChildRow) => boolean) {
    const rows = new Map<string, ChildRow>();
    const children: ScheduleChild[] = [];
    const add = (row: ChildRow) => {
      rows.set(row.id, row);
      children.push({
        id: row.id,
        settled: row.settled === 1,
        settledAt: row.settled_at,
        unconfirmed: row.stopped_unconfirmed === 1,
        paired: !lost(row),
      });
    };
    for (const row of this.ledger.unsettledOf(machine)) {
      if (lost(row)) {
        this.lost.keep(row);
        continue;
      }
      if (row.lost_at !== null) this.lost.found(row);
      add(row);
    }
    for (const row of this.ledger.recheckRows(machine)) add(row);
    return { children, rows };
  }
  /** The scheduler's records for a machine; a child saved as asked alone starts so after a restart. */
  private recordsOf(machine: string, children: readonly ScheduleChild[]) {
    const records = this.records.get(machine) ?? new Map<string, ChildRecord>();
    for (const child of children)
      if (!records.has(child.id) && this.ledger.row(child.id)?.rechecked === -1)
        records.set(child.id, restored());
    this.records.set(machine, records);
    return records;
  }
  /**
   * One call of a turn: its answer is applied the moment it arrives, then folded into the
   * scheduler's records (whatever the turn's other calls do).
   */
  private async ask(
    machine: string,
    children: readonly ScheduleChild[],
    rows: ReadonlyMap<string, ChildRow>,
    ids: readonly string[],
  ): Promise<void> {
    const first = rows.get(ids[0] ?? "");
    if (!first) return;
    let outcome: CallOutcome;
    try {
      const views = await this.deps.status(
        machine,
        first.parent_thread,
        ids.map((id) => ThreadId.parse(id)),
      );
      outcome = { kind: "answered" };
      this.reached(machine);
      for (const view of views) {
        const row = rows.get(view.threadId);
        if (!row || this.closed) continue;
        if (row.settled === 1) this.recheck(row, view);
        else this.update(row, view);
      }
      // A slow sibling machine must not hold a result already received from this one.
      if (!this.closed) this.results.drain();
    } catch (error) {
      // The machine saying it holds no record of a child is its answer for that child; any
      // other failure is no answer. A working child stays as last seen, saying why; a settled
      // child stays settled. Neither is ever settled for want of an answer.
      outcome = refusedNotFound(error) ? { kind: "not_found" } : { kind: "failed" };
      if (outcome.kind === "failed") this.unreached(machine, error);
      const reason = unreadReason(this.deps.label(machine), error);
      const working = ids.filter((id) => rows.get(id)?.settled === 0);
      for (const id of working) this.unreachable.set(id, reason);
      if (working.length) this.emit(working);
    }
    if (this.closed) return;
    const folded = foldCall(
      this.records.get(machine) ?? new Map(),
      children,
      ids,
      outcome,
      this.deps.now(),
      this.schedule,
    );
    this.records.set(machine, folded.records);
    // Read at or after their 24 h mark: they leave tracking now, never before.
    this.ledger.endRecheck(
      folded.ended.flatMap((id) => {
        const settledAt = rows.get(id)?.settled_at;
        return settledAt === null || settledAt === undefined ? [] : [{ id, settledAt }];
      }),
    );
    // Whether each is asked alone outlives a restart.
    const now = this.deps.now();
    const alone = ids.filter((id) => asksAlone(folded.records.get(id), now));
    this.ledger.setAlone(alone, true);
    this.ledger.setAlone(
      ids.filter((id) => !alone.includes(id)),
      false,
    );
  }
  /**
   * Settled children whose machine was unpaired, the person asked about each: paired again, it is
   * watched again; still unpaired, its question stays open (opened again if it closed).
   */
  private settledLost() {
    for (const row of this.ledger.settledLost()) {
      const lost = this.lostFrom(row.machine);
      if (!lost) continue;
      if (lost(row)) this.lost.keepSettled(row);
      else this.lost.foundSettled(row);
    }
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
