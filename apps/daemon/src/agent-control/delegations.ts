import { callerThread } from "./authorization.ts";
import { ReservationLifetimes } from "./reservation-lifetimes.ts";
import { controlCommandId } from "./command-id.ts";
export { controlCommandId } from "./command-id.ts";
import { delegationCommandPolicy } from "./command-policy.ts";
import { delegationBudget, childResultPrompt } from "@ace/orchestrator";
import { type AccountRegistry } from "@ace/accounts";
import {
  Command,
  ThreadId,
  DelegationPolicy,
  DelegationRequest,
  type DelegationRecord,
  type WorkspaceId,
  type McpAttribution,
  type Event,
  type DelegationOutcome,
  type CommandPayload,
} from "@ace/protocol";
import type { Engine, EngineClock } from "../engine/index.ts";
import type { Store } from "../store.ts";
import { commandContext } from "../commands.ts";
import { OutcomeWaiters } from "./waiters.ts";
import { DelegationAdmission } from "./admission.ts";
import { type DelegationReservation, DelegationJournal } from "./journal.ts";
import { threadOutcome } from "./results.ts";

export interface DelegationDependencies {
  store: Store;
  engine: Engine;
  clock: EngineClock;
  id(): string;
  accounts?: AccountRegistry;
  /** Host may lower the durable receipt cap, never raise its 10,000 hard limit. */
  journalCapacity?: number;
  policy?: Partial<DelegationPolicy>;
  onError(error: unknown): void;
  /** The daemon maintenance gate remains the owner of autonomous turn admission. */
  admitsWork?(): boolean;
}
/** Durable execution owner shared by agent tools and Deck, independent of MCP transport. */
export class DelegationService {
  readonly journal: DelegationJournal;
  readonly policy: DelegationPolicy;
  private admission: DelegationAdmission;
  private deps: DelegationDependencies;
  private unsubscribe: () => void;
  private cancelTimer: (() => void) | undefined;
  private closed = false;
  private reservationLifetimes = new ReservationLifetimes();
  private waiters = new OutcomeWaiters();
  constructor(deps: DelegationDependencies) {
    this.deps = deps;
    this.policy = DelegationPolicy.parse(deps.policy ?? {});
    this.journal = new DelegationJournal(deps.store, deps.journalCapacity);
    this.admission = new DelegationAdmission(
      deps,
      this.journal,
      this.policy,
      () => !this.closed && deps.admitsWork?.() !== false,
    );
    deps.engine.bindCommandPolicy(
      delegationCommandPolicy({
        journal: this.journal,
        policy: this.policy,
        engine: deps.engine,
        store: deps.store,
        now: () => deps.clock.now(),
        admits: () => !this.closed && deps.admitsWork?.() !== false,
        cancel: (thread, request) => this.cancelDescendants(thread, request),
        changed: () => this.arm(),
      }),
    );
    this.unsubscribe = deps.store.subscribe((events) => this.observe(events));
    // Recovery visits current work only, never transcript history or old receipts.
    for (const edge of this.journal.active()) this.reconcile(edge);
    this.arm();
  }
  authorize(caller: McpAttribution, target: ThreadId, write: boolean): boolean {
    const source = callerThread(this.deps.store, caller);
    const thread = this.deps.store.getThread(target);
    return (
      !!thread &&
      (thread.workspaceId === source.workspaceId ||
        (this.journal.get(target)?.rootId ?? target) ===
          (this.journal.get(caller.threadId)?.rootId ?? caller.threadId)) &&
      (!write || target === caller.threadId || this.journal.isDescendant(target, caller.threadId))
    );
  }
  canFork(threadId: ThreadId) {
    const thread = this.deps.store.getThread(threadId);
    return !!thread && this.deps.engine.capabilities(thread.provider).fork;
  }
  command(id: string, payload: CommandPayload) {
    const command = Command.parse({ id, deviceId: "ace-agent", payload });
    return this.deps.store.recordCommand(command.id, command.deviceId, () =>
      this.deps.engine.handler.handle(command, commandContext(this.deps.store)),
    );
  }
  /** A receipt reserves each follow-up generation once, including retries after completion. */
  message(
    caller: McpAttribution,
    requestId: string,
    threadId: ThreadId,
    text: string,
    delivery: "queue" | "steer",
  ) {
    if (
      !this.authorize(caller, threadId, true) ||
      this.closed ||
      this.deps.admitsWork?.() === false
    )
      throw new Error("Forbidden message");
    const command = Command.parse({
      id: controlCommandId(caller.threadId, requestId, "thread.message"),
      deviceId: "ace-agent",
      payload: {
        type: "thread.send",
        threadId,
        input: [{ type: "text", text }],
        delivery,
        trigger: "parent_agent",
      },
    });
    const result = this.deps.store.recordCommand(command.id, command.deviceId, () =>
      this.deps.engine.handler.handle(command, commandContext(this.deps.store)),
    );
    this.arm();
    return result;
  }
  prepare(caller: McpAttribution, value: DelegationRequest): DelegationRecord {
    return this.prepareInWorkspace(
      caller,
      value,
      callerThread(this.deps.store, caller).workspaceId,
    );
  }
  /** Host-only workspace selection for Deck/worktree owners; never exposed as tool input. */
  prepareInWorkspace(
    caller: McpAttribution,
    value: DelegationRequest,
    workspace: WorkspaceId,
  ): DelegationRecord {
    const input = DelegationRequest.parse(value);
    return this.deps.store.atomic(() => {
      if (this.closed || this.deps.admitsWork?.() === false) throw new Error("Admission closed");
      const receipt = this.journal.receipt(caller.threadId, input.requestId);
      if (receipt) {
        this.admission.match(caller, input, receipt);
        return receipt;
      }
      const reservation = this.reserve(caller, input);
      const record = this.prepareReserved(caller, reservation, workspace);
      this.arm();
      return record;
    });
  }
  reserve(caller: McpAttribution, value: DelegationRequest) {
    const reservation = this.admission.reserve(caller, value);
    this.arm();
    return reservation;
  }
  prepareReserved(
    caller: McpAttribution,
    reservation: DelegationReservation,
    workspace: WorkspaceId,
  ) {
    return this.admission.commit(caller, reservation, workspace);
  }
  watchReservation(reservation: DelegationReservation) {
    return this.reservationLifetimes.watch(reservation);
  }
  releaseReservation(reservation: DelegationReservation) {
    this.deps.store.atomic(() => this.journal.release(reservation));
    this.arm();
  }
  delegate(caller: McpAttribution, value: DelegationRequest): DelegationRecord {
    return this.deps.store.atomic(() => {
      const record = this.prepare(caller, value);
      this.launch(record, `Role: ${record.request.role}\n\nTask:\n${record.request.task}`);
      return record;
    });
  }
  launch(record: DelegationRecord, text: string): void {
    if (this.closed || this.deps.admitsWork?.() === false) throw new Error("Admission closed");
    this.deps.store.atomic(() => {
      const current = this.journal.get(record.childId);
      if (!current || current.phase !== "created") return;
      const result = this.command(controlCommandId(current.parentId, current.requestId, "launch"), {
        type: "thread.send",
        threadId: current.childId,
        input: [{ type: "text", text }],
        delivery: "queue",
        trigger: "spawn",
      });
      if (!result.ok) throw new Error(result.error);
      current.phase = "running";
      this.journal.save(current);
    });
  }
  cancelDescendants(thread: ThreadId, request = this.deps.id()) {
    this.deps.store.atomic(() => {
      const tree = this.journal.tree(thread, this.deps.clock.now());
      this.journal.cancel(thread);
      this.reservationLifetimes.cancel(thread, (target, ancestor) =>
        this.journal.isDescendant(target, ancestor),
      );
      const own = this.journal.get(thread);
      if (own && own.phase !== "settled") {
        own.phase = "cancelling";
        this.journal.save(own);
      }
      const children = this.journal
        .family(tree.root)
        .filter(
          (edge) => edge.phase !== "settled" && this.journal.isDescendant(edge.childId, thread),
        )
        .toSorted((a, b) => b.depth - a.depth);
      for (const child of children) {
        this.journal.stop(child.childId);
        child.phase = "cancelling";
        this.journal.save(child);
        const result = this.command(
          controlCommandId(child.childId, `${request}:${child.generation}`, "cascade.interrupt"),
          {
            type: "thread.interrupt",
            threadId: child.childId,
            cascade: true,
          },
        );
        if (!result.ok) throw new Error(result.error);
      }
    });
  }
  private observe(events: readonly Event[]) {
    if (this.closed) return;
    let changed = false;
    for (const event of events) {
      if (
        event.payload.type !== "thread.updated" &&
        event.payload.type !== "usage.updated" &&
        event.payload.type !== "run.started"
      )
        continue;
      if (event.payload.type === "thread.updated" && this.waiters.has(event.threadId)) {
        const thread = this.deps.store.getThread(event.threadId);
        if (thread && ["done", "failed"].includes(thread.status.state)) {
          const outcome = threadOutcome(
            this.deps.store,
            thread,
            this.journal.get(thread.id)?.phase === "cancelling",
          );
          this.waiters.deliver(thread.id, outcome);
        }
      }
      const edge = this.journal.get(event.threadId);
      if (!edge) continue;
      changed = true;
      if (event.payload.type === "run.started") {
        if (edge) this.deps.store.atomic(() => this.journal.started(event));
      } else if (event.payload.type === "usage.updated" && edge) {
        this.deps.store.atomic(() => this.journal.usage(edge.rootId, event));
        const tree = this.journal.tree(edge.rootId, this.deps.clock.now());
        if (delegationBudget(tree, this.policy, this.deps.clock.now()))
          this.cancelDescendants(edge.rootId);
      } else if (edge) this.reconcile(edge);
    }
    if (changed) this.arm();
  }
  private reconcile(edge: DelegationRecord) {
    const thread = this.deps.store.getThread(edge.childId);
    if (!thread) return;
    this.deps.store.atomic(() => {
      this.deps.engine.updateChild(edge.parentId, thread);
      if (edge.phase === "settled" || !["done", "failed"].includes(thread.status.state)) return;
      const outcome = threadOutcome(this.deps.store, thread, edge.phase === "cancelling");
      this.journal.settle(edge, outcome, this.deps.clock.now() + this.policy.coalesceMs);
      this.waiters.deliver(thread.id, outcome);
    });
  }
  async wait(
    caller: McpAttribution,
    threadId: ThreadId,
    signal: AbortSignal,
  ): Promise<DelegationOutcome> {
    signal.throwIfAborted();
    if (!this.authorize(caller, threadId, false)) throw new Error("Forbidden thread");
    const thread = this.deps.store.getThread(threadId);
    if (!thread) throw new Error("Unknown thread");
    if (["done", "failed"].includes(thread.status.state))
      return this.journal.get(threadId)?.outcome ?? threadOutcome(this.deps.store, thread);
    return this.waiters.wait(threadId, signal);
  }
  private arm() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.closed) return;
    const next = this.journal.nextWake();
    const expiry = this.journal.nextExpiry();
    const at = Math.min(
      next?.due ?? Infinity,
      expiry ? expiry.started_at + this.policy.durationMs : Infinity,
    );
    if (at === Infinity) return;
    this.cancelTimer = this.deps.clock.setTimer(
      () => {
        this.cancelTimer = undefined;
        try {
          this.drain();
        } catch (error) {
          const retry = this.journal.nextWake();
          if (retry) this.journal.deferWake(retry.parent_id, this.deps.clock.now() + 1000);
          this.deps.onError(error);
        }
        this.arm();
      },
      Math.max(0, at - this.deps.clock.now()),
    );
  }
  /** Deterministic timer boundary also used by Deck's scheduler. Never executes provider I/O. */
  drain() {
    if (this.closed) return;
    for (let limit = 0; limit < 64; limit++) {
      const expiry = this.journal.nextExpiry();
      if (!expiry || expiry.started_at + this.policy.durationMs > this.deps.clock.now()) break;
      this.cancelDescendants(expiry.root_id);
    }
    for (let batch = 0; batch < 64; batch++) {
      const next = this.journal.nextWake();
      if (!next || next.due > this.deps.clock.now()) break;
      this.deps.store.atomic(() => {
        const parent = this.deps.store.getThread(next.parent_id);
        const tree = this.journal.tree(next.parent_id, this.deps.clock.now());
        const pending = this.journal.pending(next.parent_id);
        const cancelled =
          tree.cancelled ||
          this.journal.stopped(next.parent_id) ||
          this.journal.ancestorStopped(next.parent_id) ||
          this.journal.get(next.parent_id)?.phase === "cancelling";
        if (!parent || cancelled) {
          this.journal.consume(next.parent_id);
          return;
        }
        if (this.deps.admitsWork?.() === false) {
          this.journal.deferWake(next.parent_id, this.deps.clock.now() + 1000);
          return;
        }
        const results = pending.flatMap((edge) => (edge.outcome ? [edge.outcome] : []));
        if (!results.length) {
          this.journal.consume(next.parent_id);
          return;
        }
        const id = controlCommandId(
          next.parent_id,
          pending.map((edge) => `${edge.childId}:${edge.generation}`).join(","),
          "wake",
        );
        const result = this.command(id, {
          type: "thread.send",
          threadId: next.parent_id,
          input: [{ type: "text", text: childResultPrompt(results) }],
          delivery: "queue",
          trigger: "subagent_result",
        });
        if (!result.ok) throw new Error(result.error);
        this.journal.consume(next.parent_id);
      });
    }
  }
  close() {
    this.closed = true;
    this.reservationLifetimes.close();
    this.waiters.close();
    this.unsubscribe();
    this.cancelTimer?.();
  }
}
