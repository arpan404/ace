import { callerThread } from "./authorization.ts";
import { ReservationLifetimes } from "./reservation-lifetimes.ts";
import { controlCommandId } from "./command-id.ts";
export { controlCommandId } from "./command-id.ts";
import { delegationCommandPolicy } from "./command-policy.ts";
import { delegationBudget, childResultPrompt } from "@ace/orchestrator";
import { type AccountRegistry } from "@ace/accounts";
import {
  CommandId,
  DeviceId,
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
  models: import("@ace/models").ModelCatalogApi;
  modelsReady?: Promise<void>;
  configuredModel?(caller: McpAttribution, request: DelegationRequest): Promise<string | undefined>;
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
  private retryAt = 0;
  private suspending = new Set<ThreadId>();
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
        suspending: (thread) => this.suspending.has(thread),
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
  commandReceipt(id: string) {
    return this.deps.store.commandReceipt(CommandId.parse(id), DeviceId.parse("ace-agent"));
  }
  command(id: string, payload: CommandPayload) {
    const command = Command.parse({ id, deviceId: "ace-agent", payload });
    return this.deps.store.recordCommand(command.id, command.deviceId, () =>
      this.deps.engine.internalHandler.handle(command, commandContext(this.deps.store)),
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
      this.deps.engine.internalHandler.handle(command, commandContext(this.deps.store)),
    );
    this.arm();
    return result;
  }
  async prepareModels(caller: McpAttribution, request: DelegationRequest) {
    await this.deps.modelsReady;
    const catalog = this.deps.models;
    const filter = {
      provider: request.provider,
      ...(request.provider === "acp"
        ? {
            acpAgentId: request.acpAgentId,
            installationId: request.installationId,
            instanceId: request.instanceId,
          }
        : request.accountId
          ? { instance: request.accountId }
          : {}),
    };
    const page = catalog.list(filter);
    // Auto-selection can choose an account whose catalog is still cold.
    if (
      !page.models.length ||
      page.instances.some((instance) => instance.refreshedAt === undefined)
    )
      await catalog.refresh(filter);
    return this.deps.configuredModel?.(caller, request);
  }
  prepare(
    caller: McpAttribution,
    value: DelegationRequest,
    configuredModel?: string,
  ): DelegationRecord {
    return this.prepareInWorkspace(
      caller,
      value,
      callerThread(this.deps.store, caller).workspaceId,
      configuredModel,
    );
  }
  /** Host-only workspace selection for Deck/worktree owners; never exposed as tool input. */
  prepareInWorkspace(
    caller: McpAttribution,
    value: DelegationRequest,
    workspace: WorkspaceId,
    configuredModel?: string,
  ): DelegationRecord {
    const input = DelegationRequest.parse(value);
    return this.deps.store.atomic(() => {
      if (this.closed || this.deps.admitsWork?.() === false) throw new Error("Admission closed");
      const receipt = this.journal.receipt(caller.threadId, input.requestId);
      if (receipt) {
        this.admission.match(caller, input, receipt);
        return receipt;
      }
      const reservation = this.reserve(caller, input, undefined, configuredModel);
      const record = this.prepareReserved(caller, reservation, workspace);
      this.arm();
      return record;
    });
  }
  reserve(
    caller: McpAttribution,
    value: DelegationRequest,
    resultDelivery?: "owner",
    configuredModel?: string,
  ) {
    const reservation = this.admission.reserve(caller, value, resultDelivery, configuredModel);
    this.arm();
    return reservation;
  }
  prepareReserved(
    caller: McpAttribution,
    reservation: DelegationReservation,
    workspace: WorkspaceId,
    ownership?: {
      resultDelivery: "owner";
      handoffFrom?: ThreadId;
      deck?: import("@ace/protocol").DeckOwnership;
    },
  ) {
    return this.admission.commit(caller, reservation, workspace, ownership);
  }
  watchReservation(reservation: DelegationReservation) {
    return this.reservationLifetimes.watch(reservation);
  }
  releaseReservation(reservation: DelegationReservation) {
    this.deps.store.atomic(() => this.journal.release(reservation));
    this.arm();
  }
  delegate(
    caller: McpAttribution,
    value: DelegationRequest,
    configuredModel?: string,
  ): DelegationRecord {
    return this.deps.store.atomic(() => {
      const record = this.prepare(caller, value, configuredModel);
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
        origin: {
          kind: current.request.role.startsWith("automation:")
            ? "automation"
            : current.request.role.startsWith("handoff:")
              ? "handoff"
              : "spawn",
          parentThreadId: current.parentId,
          role: current.request.role,
        },
      });
      if (!result.ok) throw new Error(result.error);
      current.phase = "running";
      this.journal.save(current);
    });
  }
  /** Host-owned pause preserves recovery history and does not write subtree stop markers. */
  suspend(thread: ThreadId, request: string) {
    this.deps.engine.captureContinuation(thread);
    this.suspending.add(thread);
    try {
      return this.command(request, { type: "thread.interrupt", threadId: thread, cascade: true });
    } finally {
      this.suspending.delete(thread);
    }
  }
  cancelDescendants(thread: ThreadId, request = this.deps.id()) {
    this.deps.store.atomic(() => {
      const tree = this.journal.tree(thread, this.deps.clock.now());
      this.journal.cancel(thread);
      if (this.deps.store.getThread(thread)) this.deps.engine.discardRecovery(thread);
      this.reservationLifetimes.cancel(thread, (target, ancestor) =>
        this.journal.isDescendant(target, ancestor),
      );
      const own = this.journal.get(thread);
      if (own && own.phase !== "settled") {
        own.phase = "cancelling";
        this.journal.save(own);
        const child = this.deps.store.getThread(own.childId);
        if (child) this.deps.engine.delegationStarted(own, child);
      }
      const children = this.journal
        .family(tree.root)
        .filter(
          (edge) => edge.phase !== "settled" && this.journal.isDescendant(edge.childId, thread),
        )
        .toSorted((a, b) => b.depth - a.depth);
      for (const child of children) {
        this.journal.stop(child.childId);
        if (this.deps.store.getThread(child.childId)) {
          this.deps.engine.discardRecovery(child.childId);
          this.deps.engine.cancelDelegatedInputs(child.childId);
        }
        child.phase = "cancelling";
        this.journal.save(child);
        const childThread = this.deps.store.getThread(child.childId);
        if (childThread) this.deps.engine.delegationStarted(child, childThread);
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
      if (edge.phase === "settled" || !["done", "failed"].includes(thread.status.state)) {
        this.deps.engine.delegationStarted(edge, thread);
        return;
      }
      const outcome = threadOutcome(this.deps.store, thread, edge.phase === "cancelling");
      this.journal.settle(edge, outcome, this.deps.clock.now() + this.policy.coalesceMs);
      this.deps.engine.delegationStarted(edge, thread);
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
    const outcome = ["done", "failed"].includes(thread.status.state)
      ? (this.journal.get(threadId)?.outcome ?? threadOutcome(this.deps.store, thread))
      : await this.waiters.wait(threadId, signal);
    const edge = this.journal.get(threadId);
    if (edge && edge.parentId === caller.threadId && edge.resultDelivery !== "owner") {
      this.deps.store.atomic(() => {
        this.deps.engine.delegationSettled(
          edge.parentId,
          edge.parentAgentId,
          controlCommandId(edge.parentId, `${edge.childId}:${edge.generation}`, "tool-result"),
          [outcome],
          "tool",
        );
        this.journal.consumeChild(threadId);
      });
    }
    return outcome;
  }
  private arm() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.closed) return;
    let next: ReturnType<DelegationJournal["nextWake"]>;
    let expiry: ReturnType<DelegationJournal["nextExpiry"]>;
    try {
      next = this.journal.nextWake();
      expiry = this.journal.nextExpiry(this.policy.durationMs);
    } catch (error) {
      this.report(error);
      this.cancelTimer = this.deps.clock.setTimer(() => this.timer(), 1000);
      return;
    }
    const at = Math.min(next?.due ?? Infinity, expiry?.due ?? Infinity);
    if (at === Infinity) return;
    this.cancelTimer = this.deps.clock.setTimer(
      () => this.timer(),
      Math.max(0, at - this.deps.clock.now(), this.retryAt - this.deps.clock.now()),
    );
  }
  private report(error: unknown) {
    try {
      this.deps.onError(error);
    } catch {
      /* Reporting cannot disable retry. */
    }
  }
  private timer() {
    this.cancelTimer = undefined;
    if (this.closed) return;
    try {
      this.drain();
      this.retryAt = 0;
    } catch (error) {
      this.retryAt = this.deps.clock.now() + 1000;
      this.report(error);
    }
    this.arm();
  }
  /** Deterministic timer boundary also used by Deck's scheduler. Never executes provider I/O. */
  drain() {
    if (this.closed) return;
    for (let limit = 0; limit < 64; limit++) {
      const expiry = this.journal.nextExpiry(this.policy.durationMs);
      if (!expiry || expiry.due > this.deps.clock.now()) break;
      try {
        this.cancelDescendants(expiry.root_id);
      } catch (error) {
        this.deps.store.atomic(() =>
          this.journal.deferExpiry(
            expiry.root_id,
            this.deps.clock.now() + Math.min(30000, 1000 * 2 ** Math.min(expiry.failures, 5)),
          ),
        );
        this.report(error);
      }
    }
    for (let batch = 0; batch < 64; batch++) {
      const next = this.journal.nextWake();
      if (!next || next.due > this.deps.clock.now()) break;
      try {
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
          const text = `[ace-origin:delegation.settled:${id}]\n${childResultPrompt(results)}`;
          const agent = pending[0]?.parentAgentId;
          if (!agent) throw new Error("Missing delegation owner");
          this.deps.engine.delegationSettled(next.parent_id, agent, id, results, "ace-input", text);
          const result = this.command(id, {
            type: "thread.send",
            threadId: next.parent_id,
            input: [{ type: "text", text }],
            delivery: "queue",
            trigger: "subagent_result",
            origin: { kind: "subagent_result", threadIds: pending.map((edge) => edge.childId) },
          });
          if (!result.ok) throw new Error(result.error);
          this.journal.consume(next.parent_id);
        });
      } catch (error) {
        this.deps.store.atomic(() =>
          this.journal.deferWake(next.parent_id, this.deps.clock.now() + 1000),
        );
        this.report(error);
      }
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
