import { delegationRequest } from "./cursor-request.ts";
import { AgentControlError, controlAdmissionError } from "./failure.ts";
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
import { readAgentCatalog } from "./catalog.ts";
import { incomingRemoteRoot } from "./incoming-root.ts";
import { recoverLocalUsage } from "./local-usage-recovery.ts";
import { recoverIncomingUsage } from "./incoming-usage-recovery.ts";
import { AcpIdentity as importAcpIdentitySchema } from "@ace/protocol";
import { delegationModel } from "./models.ts";
import { ConversationJournal } from "./conversation-journal.ts";
import { matchesModel, isDefaultSelection, selectionModelFilter } from "@ace/models";

export interface DelegationDependencies {
  store: Store;
  engine: Engine;
  clock: EngineClock;
  id(): string;
  accounts?: AccountRegistry;
  models: import("@ace/models").ModelCatalogApi;
  modelsReady?: Promise<void>;
  providerEnabled?(provider: import("@ace/protocol").ProviderKind, instance?: string): boolean;
  configuredModel?(caller: McpAttribution, request: DelegationRequest): Promise<string | undefined>;
  /** Host may lower the durable receipt cap, never raise its 10,000 hard limit. */
  journalCapacity?: number;
  policy?: Partial<DelegationPolicy>;
  externalCapacity?(
    parent: ThreadId,
    root: ThreadId,
  ): { concurrent: number; children: number; usage: { tokens: number; cost: number } };
  onError(error: unknown): void;
  /** The daemon maintenance gate remains the owner of autonomous turn admission. */
  admitsWork?(): boolean;
}
/** Durable execution owner shared by agent tools and host callers, independent of MCP transport. */
export class DelegationService {
  readonly journal: DelegationJournal;
  readonly policy: DelegationPolicy;
  readonly conversations: ConversationJournal;
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
    recoverIncomingUsage(deps.store, this.journal, deps.clock.now());
    recoverLocalUsage(deps.store, this.journal);
    this.conversations = new ConversationJournal(deps.store);
    const external = deps.externalCapacity;
    this.deps = {
      ...deps,
      externalCapacity: (parent, root) => {
        const remote = external?.(parent, root);
        const conversations = this.conversations.capacity(parent, root);
        return {
          concurrent: (remote?.concurrent ?? 0) + conversations.concurrent,
          children: (remote?.children ?? 0) + conversations.children,
          usage: remote?.usage ?? { tokens: 0, cost: 0 },
        };
      },
    };
    this.admission = new DelegationAdmission(
      this.deps,
      this.journal,
      this.policy,
      () => !this.closed && deps.admitsWork?.() !== false,
    );
    deps.engine.bindDeletionPolicy((thread, request) => this.cancelDescendants(thread, request));
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
        capacity: (parent) => this.admission.capacity(parent, deps.clock.now()),
        conversationAdmission: (thread) => {
          const owner = this.conversations.get(thread);
          if (!owner) return undefined;
          if (this.closed || deps.admitsWork?.() === false) return "admission_closed";
          const capacity = this.admission.capacity(owner.ownerThreadId, deps.clock.now());
          const rejected = delegationBudget(capacity, this.policy, deps.clock.now());
          if (rejected) return rejected;
          const state = deps.store.getThread(thread)?.status.state;
          return state &&
            ["done", "failed", "new"].includes(state) &&
            capacity.concurrent >= this.policy.maxConcurrent
            ? "concurrency_limit"
            : undefined;
        },
      }),
    );
    this.unsubscribe = deps.store.subscribe((events) => this.observe(events));
    // Recovery visits current work only, never transcript history or old receipts.
    for (const edge of [...this.journal.active(), ...this.journal.revived()]) this.reconcile(edge);
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
      (!write ||
        target === caller.threadId ||
        this.journal.isDescendant(target, caller.threadId) ||
        this.conversations.owns(caller, this.journal.get(target)?.rootId ?? target))
    );
  }
  catalog(
    caller: McpAttribution,
    input: import("zod").z.infer<typeof import("@ace/protocol").AgentCatalogInput>,
  ) {
    return readAgentCatalog(this.deps, caller, input);
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
  async prepareModels(caller: McpAttribution, value: DelegationRequest) {
    const request = delegationRequest(value);
    this.admission.validate(caller, request);
    await this.deps.modelsReady;
    if (
      request.accountId &&
      this.deps.accounts?.get(request.accountId)?.instance.provider !== request.provider
    )
      throw new AgentControlError(
        "account_unavailable",
        `Account ${request.accountId} does not belong to ${request.provider}`,
      );
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
  /** Host-only workspace selection for worktree owners; never exposed as tool input. */
  prepareInWorkspace(
    caller: McpAttribution,
    value: DelegationRequest,
    workspace: WorkspaceId,
    configuredModel?: string,
  ): DelegationRecord {
    const input = delegationRequest(value);
    return this.deps.store.atomic(() => {
      if (this.closed || this.deps.admitsWork?.() === false)
        throw new AgentControlError("admission_closed", "Admission closed");
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
    },
    prepared?: Pick<import("../commands.ts").CommandContext, "preparedWorkspace">,
  ) {
    return this.admission.commit(caller, reservation, workspace, ownership, prepared);
  }
  /** Reuse selection/admission and permission ancestry without attaching a child edge. */
  prepareConversation(
    caller: McpAttribution,
    reservation: DelegationReservation,
    workspace: WorkspaceId,
    prepared?: Pick<import("../commands.ts").CommandContext, "preparedWorkspace">,
  ) {
    return this.deps.store.atomic(() => {
      const { child } = this.admission.createThread(
        caller,
        reservation,
        workspace,
        undefined,
        prepared,
      );
      this.journal.release(reservation);
      return child;
    });
  }
  restartMessage(caller: McpAttribution, requestId: string, threadId: ThreadId, text: string) {
    if (
      !this.authorize(caller, threadId, true) ||
      this.closed ||
      this.deps.admitsWork?.() === false
    )
      throw new Error("Forbidden restart");
    const id = controlCommandId(caller.threadId, requestId, "thread.restart_message");
    return this.deps.store.recordCommand(CommandId.parse(id), DeviceId.parse("ace-agent"), () => {
      this.cancelPreparations(threadId);
      const tree = this.journal.tree(threadId, this.deps.clock.now());
      for (const child of this.journal
        .family(tree.root)
        .filter((edge) => edge.parentId === threadId && edge.phase !== "settled")) {
        this.cancelDescendants(child.childId, id);
        const cancelled = this.command(
          controlCommandId(child.childId, requestId, "restart.child_interrupt"),
          { type: "thread.interrupt", threadId: child.childId, cascade: true },
        );
        if (!cancelled.ok) throw controlAdmissionError(cancelled.error ?? "Child interrupt failed");
      }
      this.onRemoteCancel?.(threadId);
      this.suspending.add(threadId);
      try {
        const stopped = this.command(
          controlCommandId(caller.threadId, requestId, "restart.interrupt"),
          { type: "thread.interrupt", threadId, cascade: true },
        );
        if (!stopped.ok) throw controlAdmissionError(stopped.error ?? "Restart interrupt failed");
      } finally {
        this.suspending.delete(threadId);
      }
      // Explicit replacement clears obsolete recovery/limit holds. Ordinary Stop
      // still retains its queue; restart moves this new message before retained input.
      this.deps.engine.discardRecovery(threadId);
      const sent = this.message(caller, requestId, threadId, text, "queue");
      if (!sent.ok) throw controlAdmissionError(sent.error ?? "Restart send failed");
      const queue = this.deps.engine.queue(threadId);
      if (queue.messages.length > 1) {
        const moved = this.command(controlCommandId(caller.threadId, requestId, "restart.first"), {
          type: "queue.move",
          threadId,
          messageId: sent.commandId,
          after: null,
          expectedRevision: queue.revision,
        });
        if (!moved.ok) throw controlAdmissionError(moved.error ?? "Restart input unavailable");
      }
      return { ...sent, commandId: CommandId.parse(id) };
    });
  }
  async configure(
    caller: McpAttribution,
    operation: Extract<import("@ace/protocol").AgentControlOperation, { op: "thread.configure" }>,
    signal: AbortSignal,
  ) {
    if (!this.authorize(caller, operation.threadId, true))
      throw new Error("Forbidden configuration");
    const thread = this.deps.store.getThread(operation.threadId);
    if (!thread) throw new Error("Thread missing");
    const identity = thread.provider === "acp" ? importAcpIdentitySchema.parse(thread) : undefined;
    const request = DelegationRequest.parse({
      requestId: operation.requestId,
      provider: thread.provider,
      ...identity,
      instanceId: thread.execution?.instanceId ?? identity?.instanceId,
      permissionMode: this.deps.engine.permissionMode(thread.id) ?? undefined,
      model: operation.model,
      options: operation.options,
      role: "configuration",
      task: "configure",
    });
    await this.prepareModels(caller, request);
    signal.throwIfAborted();
    const filter = selectionModelFilter(thread.provider, thread.execution?.instanceId, identity);
    const selected =
      filter &&
      this.deps.models.resolve({ role: "configuration", ...filter, model: operation.model });
    if (
      !selected?.ok ||
      (!isDefaultSelection(operation.model) && !matchesModel(selected.model, operation.model))
    )
      throw new AgentControlError(
        "model_unavailable",
        "Requested configuration model is unavailable",
      );
    const model = delegationModel(this.deps.models, request, thread, thread.execution?.instanceId);
    const command = Command.parse({
      id: controlCommandId(caller.threadId, operation.requestId, operation.op),
      deviceId: "ace-agent",
      payload: {
        type: "thread.switch",
        threadId: thread.id,
        selection: {
          provider: thread.provider,
          model,
          ...(thread.execution?.instanceId ? { instanceId: thread.execution.instanceId } : {}),
          ...(operation.options ? { options: operation.options } : {}),
        },
      },
    });
    await this.deps.engine.prepareCommand(command);
    signal.throwIfAborted();
    if (!this.authorize(caller, thread.id, true)) throw new Error("Forbidden configuration");
    return this.command(command.id, command.payload);
  }
  /** Observation timeout releases the waiter so the existing durable wake can deliver. */
  async waitBounded(
    caller: McpAttribution,
    child: ThreadId,
    signal: AbortSignal,
    milliseconds: number,
  ) {
    const deadline = new AbortController();
    const cancel = this.deps.clock.setTimer(() => deadline.abort(), milliseconds);
    try {
      return await this.wait(caller, child, AbortSignal.any([signal, deadline.signal]));
    } catch (error) {
      signal.throwIfAborted();
      if (!deadline.signal.aborted) throw error;
      return undefined;
    } finally {
      cancel();
      this.arm();
    }
  }
  watchReservation(reservation: DelegationReservation): ReturnType<ReservationLifetimes["watch"]> {
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
    if (this.closed || this.deps.admitsWork?.() === false)
      throw new AgentControlError("admission_closed", "Admission closed");
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
      if (!result.ok) throw controlAdmissionError(result.error ?? "Launch failed");
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
  onRemoteCancel: ((thread: ThreadId) => void) | undefined;
  private cancelPreparations(thread: ThreadId): void {
    this.reservationLifetimes.cancel(thread, (target, ancestor) =>
      this.journal.isDescendant(target, ancestor),
    );
    for (const reservation of this.journal.reservations())
      if (
        reservation.record.parentId === thread ||
        this.journal.isDescendant(reservation.record.parentId, thread)
      )
        this.journal.release(reservation);
  }
  cancelDescendants(thread: ThreadId, request = this.deps.id()) {
    this.deps.store.atomic(() => {
      this.onRemoteCancel?.(thread);
      const tree = this.journal.tree(thread, this.deps.clock.now());
      this.journal.cancel(thread);
      if (this.deps.store.getThread(thread)) this.deps.engine.discardRecovery(thread);
      this.cancelPreparations(thread);
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
        this.journal.suppressWake(child.childId);
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
        if (!result.ok) throw controlAdmissionError(result.error ?? "Launch failed");
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
      if (!edge) {
        // Incoming roots have no local parent edge. Reuse the durable counter owner
        // so terminal snapshots never depend on asynchronous analytics catch-up.
        if (
          (event.payload.type === "run.started" || event.payload.type === "usage.updated") &&
          incomingRemoteRoot(this.deps.store, event.threadId)
        )
          this.deps.store.atomic(() => {
            this.journal.tree(event.threadId, this.deps.clock.now());
            this.journal.started(event);
            this.journal.usage(event.threadId, event);
          });
        continue;
      }
      changed = true;
      if (event.payload.type === "run.started") {
        if (edge) this.journal.account(edge.rootId, event);
        this.reconcile(edge);
      } else if (event.payload.type === "usage.updated" && edge) {
        this.journal.account(edge.rootId, event);
        const tree = this.admission.capacity(edge.rootId, this.deps.clock.now());
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
      if (edge.phase === "settled" && !["done", "failed"].includes(thread.status.state)) {
        this.journal.revive(edge);
        const tree = this.admission.capacity(edge.parentId, this.deps.clock.now());
        if (
          this.journal.stopped(edge.childId) ||
          this.journal.ancestorStopped(edge.childId) ||
          tree.cancelled ||
          delegationBudget(tree, this.policy, this.deps.clock.now()) ||
          tree.concurrent > this.policy.maxConcurrent ||
          this.journal.activeCount() > 64
        ) {
          const request = controlCommandId(
            edge.childId,
            String(edge.generation),
            "native.interrupt",
          );
          this.cancelDescendants(edge.childId, request);
          const result = this.command(request, {
            type: "thread.interrupt",
            threadId: edge.childId,
            cascade: true,
          });
          if (!result.ok) throw controlAdmissionError(result.error ?? "Interrupt failed");
          edge.phase = "cancelling";
        }
      }
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
      : await this.waiters.wait(threadId, signal, caller.threadId);
    signal.throwIfAborted();
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
  /** Deterministic timer boundary for host scheduling. Never executes provider I/O. */
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
          if (!result.ok) throw controlAdmissionError(result.error ?? "Launch failed");
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
