import { delegationRequest } from "./cursor-request.ts";
import { AgentControlError, controlAdmissionError, engineFull } from "./failure.ts";
import { callerThread } from "./authorization.ts";
import { ReservationLifetimes } from "./reservation-lifetimes.ts";
import { controlCommandId } from "./command-id.ts";
import { agentSubtree } from "./agent-subtree.ts";
export { controlCommandId } from "./command-id.ts";
import { delegationCommandPolicy } from "./command-policy.ts";
import { childResultPrompt, launchSlots } from "@ace/orchestrator";
import { LaunchQueue } from "./launch-queue.ts";
import { childStatus, queuedStatus } from "./child-status.ts";
import { accountProvider, type AccountRegistry } from "@ace/accounts";
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
  type CommandResult,
} from "@ace/protocol";
import type { Engine, EngineClock } from "../engine/index.ts";
import type { Store } from "../store.ts";
import { commandContext } from "../commands.ts";
import { OutcomeWaiters } from "./waiters.ts";
import { AgentMonitor } from "./monitor.ts";
import { DelegationAdmission } from "./admission.ts";
import { type DelegationReservation, DelegationJournal } from "./journal.ts";
import { threadOutcome } from "./results.ts";
import { messageArrival } from "./message-arrival.ts";
import { deliveryNotice, noticeText, type DeliveryNotice } from "./message-notices.ts";
import { readAgentCatalog } from "./catalog.ts";
import { recoverLocalUsage } from "./local-usage-recovery.ts";
import { AcpIdentity as importAcpIdentitySchema } from "@ace/protocol";
import { delegationEffort, selectedDelegationModel } from "./models.ts";
import { ConversationJournal } from "./conversation-journal.ts";
import {
  executionModelId,
  matchesModel,
  isDefaultSelection,
  selectionModelFilter,
} from "@ace/models";

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
  onError(error: unknown): void;
  /** The daemon maintenance gate remains the owner of autonomous turn admission. */
  admitsWork?(): boolean;
}
/** Durable execution owner shared by agent tools and host callers, independent of MCP transport. */
export class DelegationService {
  readonly journal: DelegationJournal;
  readonly policy: DelegationPolicy;
  readonly conversations: ConversationJournal;
  private launches: LaunchQueue;
  private admission: DelegationAdmission;
  private deps: DelegationDependencies;
  private unsubscribe: () => void;
  private cancelTimer: (() => void) | undefined;
  private closed = false;
  private retryAt = 0;
  private suspending = new Set<ThreadId>();
  private reservationLifetimes = new ReservationLifetimes();
  private waiters = new OutcomeWaiters();
  /** Bounded multi-thread waits and tree snapshots for agent tools. */
  readonly monitor: AgentMonitor;
  constructor(deps: DelegationDependencies) {
    this.deps = deps;
    this.policy = DelegationPolicy.parse(deps.policy ?? {});
    this.journal = new DelegationJournal(deps.store, deps.journalCapacity);
    this.conversations = new ConversationJournal(deps.store);
    this.launches = new LaunchQueue(deps.store);
    // Upgrade old ownership metadata once without decoding prompts or transcripts.
    for (const conversation of this.conversations.unenrolledMembers()) {
      this.journal.enroll(conversation.thread_id, conversation.root_id);
      this.journal.activity(conversation.thread_id, conversation.active);
    }
    recoverLocalUsage(deps.store, this.journal);
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
        engine: deps.engine,
        store: deps.store,
        now: () => deps.clock.now(),
        admits: () => !this.closed && deps.admitsWork?.() !== false,
        cancel: (thread, request) => this.cancelDescendants(thread, request),
        cancelAgent: (thread, agentId, request) => this.cancelAgentWork(thread, agentId, request),
        changed: () => this.arm(),
        suspending: (thread) => this.suspending.has(thread),
        requestingAgent: () => this.requesting,
        launchQueued: (child) => this.launchQueued(child),
        resumeRestartHeld: (thread, request) => this.resumeRestartHeld(thread, request),
        conversationAccepted: (thread) => {
          this.journal.activity(thread, 1);
        },
        conversationAdmission: (thread) =>
          this.conversations.get(thread) && (this.closed || deps.admitsWork?.() === false)
            ? "admission_closed"
            : undefined,
      }),
    );
    this.unsubscribe = deps.store.subscribe((events) => this.observe(events));
    // Subscribed after the owner, so a wait reads edges this owner settled for the same batch.
    this.monitor = new AgentMonitor({
      store: deps.store,
      journal: this.journal,
      clock: deps.clock,
      authorize: (caller, target, write) => this.authorize(caller, target, write),
      delivered: (caller, outcome) => this.delivered(caller, outcome),
    });
    // Recovery visits indexed current work, never transcript history or old receipts.
    for (const participant of this.journal.activeParticipants()) {
      this.reconcileConversation(participant.thread_id);
    }
    for (const edge of [...this.journal.active(), ...this.journal.revived()]) {
      this.reconcile(edge);
    }
    this.pumpAll();
    this.arm();
  }
  authorize(caller: McpAttribution, target: ThreadId, write: boolean): boolean {
    const source = callerThread(this.deps.store, caller);
    const thread = this.deps.store.getThread(target);
    if (!thread) return false;
    // A conversation the caller started is its own, in whichever project it was opened.
    if (this.ownsConversationTree(caller, target)) return true;
    // Full access acts for the person: it reads every thread and changes any top-level one,
    // never another agent's delegated child.
    if (this.actsForPerson(caller) && (!write || !this.journal.get(target))) return true;
    return (
      (thread.workspaceId === source.workspaceId ||
        (this.journal.get(target)?.rootId ?? target) ===
          (this.journal.get(caller.threadId)?.rootId ?? caller.threadId)) &&
      (!write || target === caller.threadId || this.journal.isDescendant(target, caller.threadId))
    );
  }
  /**
   * A top-level thread with full access may act on the person's threads as the person would.
   * A delegated child works on its task and never gains that reach, whatever its access.
   */
  actsForPerson(caller: McpAttribution): boolean {
    const source = this.deps.store.getThread(caller.threadId);
    return source?.permission?.effective === "full-access" && !this.journal.get(caller.threadId);
  }
  /** A thread's queued messages, oldest first, with the revision edits must name. */
  queue(threadId: ThreadId) {
    return this.deps.engine.queue(threadId);
  }
  private ownsConversationTree(caller: McpAttribution, target: ThreadId): boolean {
    let thread = target;
    for (let depth = 0; depth <= 8; depth++) {
      if (this.conversations.owns(caller, thread)) return true;
      const edge = this.journal.get(thread);
      if (!edge) return false;
      thread = edge.parentId;
    }
    return false;
  }
  private reconcileConversation(threadId: ThreadId): void {
    const thread = this.deps.store.getThread(threadId);
    this.journal.activity(
      threadId,
      thread &&
        thread.deletedAt === undefined &&
        !["done", "failed", "new"].includes(thread.status.state)
        ? 1
        : 0,
    );
  }
  /** The model catalog's page reader, for filling in a selection an agent left open. */
  listModels(options: import("@ace/protocol").ModelListOptions) {
    return this.deps.models.list(options);
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
  /** The service's clock, for owners that stamp what an agent changed. */
  now(): number {
    return this.deps.clock.now();
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
    // The child's new work, if this reopens it, belongs to the turn of the agent asking.
    this.requesting = caller.agentId;
    let result: CommandResult;
    try {
      result = this.deps.store.recordCommand(command.id, command.deviceId, () =>
        this.deps.engine.internalHandler.handle(command, commandContext(this.deps.store)),
      );
    } finally {
      this.requesting = undefined;
    }
    // A new message supersedes what the parent was told about an earlier one.
    const edge = result.ok ? this.journal.get(threadId) : undefined;
    if (edge?.messageNotice) {
      delete edge.messageNotice;
      this.journal.save(edge);
    }
    this.arm();
    return result;
  }
  private requesting: string | undefined;
  /** A kept-back message the child has now taken is no longer news for the parent. */
  private clearDeliveredNotice(child: ThreadId) {
    const edge = this.journal.get(child);
    const commandId = edge?.messageNotice?.commandId;
    if (!edge || !commandId) return;
    if (this.deps.engine.inputFate(child, CommandId.parse(commandId)).state !== "delivered") return;
    delete edge.messageNotice;
    this.deps.store.atomic(() => this.journal.save(edge));
  }
  /**
   * A parent's message to its child that didn't go in as sent (refused, kept back, uncertain or
   * failed after the tool returned). The parent hears it the way it hears results, once per
   * message and outcome, and agents_status shows it until the parent sends again.
   */
  private noticeParent(child: ThreadId, notice: DeliveryNotice) {
    const edge = this.journal.get(child);
    if (
      !edge ||
      !this.deps.engine.messageFacts(child, CommandId.parse(notice.commandId)).fromParent
    )
      return;
    const text = noticeText(notice, edge.request.role, child);
    const id = controlCommandId(edge.parentId, `${child}:${notice.commandId}`, notice.code);
    if (this.commandReceipt(id)) return;
    this.deps.store.atomic(() => {
      edge.messageNotice = {
        text: text.slice(0, 400),
        at: this.deps.clock.now(),
        commandId: notice.commandId,
      };
      this.journal.save(edge);
    });
    try {
      const delivery = this.deps.engine.supportsSteering(edge.parentId) ? "steer" : "queue";
      const result = this.command(id, {
        type: "thread.send",
        threadId: edge.parentId,
        input: [{ type: "text", text: `[ace-origin:delegation.message_notice:${id}]\n${text}` }],
        delivery,
        trigger: "subagent_result",
        origin: { kind: "subagent_result", threadIds: [child] },
      });
      if (!result.ok) throw controlAdmissionError(result.error ?? "Notice not delivered");
      if (delivery === "queue")
        this.deps.engine.prioritizeSubagentResult(edge.parentId, result.commandId);
    } catch (error) {
      this.report(error);
    }
  }
  /** How the message `requestId` sent to `threadId` reaches it, read once it was accepted. */
  arrival(caller: McpAttribution, requestId: string, threadId: ThreadId, restart = false) {
    const id = CommandId.parse(controlCommandId(caller.threadId, requestId, "thread.message"));
    return messageArrival(this.deps.engine.messageFacts(threadId, id), restart);
  }
  async prepareModels(caller: McpAttribution, value: DelegationRequest) {
    const request = delegationRequest(value);
    this.admission.validate(caller, request);
    await this.deps.modelsReady;
    const account = request.accountId ? this.deps.accounts?.get(request.accountId) : undefined;
    // An added Antigravity account is stored as an ACP account but belongs to Antigravity.
    if (
      request.accountId &&
      (!account ||
        (account.instance.provider !== request.provider &&
          accountProvider(account.instance) !== request.provider))
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
      this.journal.enroll(child.id, reservation.record.rootId);
      return child;
    });
  }
  /** The name the person gave an account ("Work"), for what an agent tells them. */
  accountLabel(id: string | undefined): string | undefined {
    if (!id) return undefined;
    try {
      return this.deps.accounts?.get(id)?.instance.label;
    } catch {
      // Account homes are still being validated: the answer goes without the name.
      return undefined;
    }
  }
  /**
   * A restart's first step: everything `threadId` delegated stops, here and on other machines,
   * so the new message is all that runs next.
   */
  stopChildren(threadId: ThreadId, requestId: string, request: string) {
    this.cancelPreparations(threadId);
    for (const child of this.journal
      .liveDescendants(threadId)
      .filter((edge) => edge.parentId === threadId)) {
      this.cancelDescendants(child.childId, request);
      const cancelled = this.command(
        controlCommandId(child.childId, requestId, "restart.child_interrupt"),
        { type: "thread.interrupt", threadId: child.childId, cascade: true },
      );
      if (!cancelled.ok) throw controlAdmissionError(cancelled.error ?? "Child interrupt failed");
    }
    this.onRemoteCancel?.(threadId);
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
      this.stopChildren(threadId, requestId, id);
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
    const selection = await this.threadSelection(
      caller,
      thread,
      operation.requestId,
      operation.model,
      operation.options,
    );
    signal.throwIfAborted();
    const command = Command.parse({
      id: controlCommandId(caller.threadId, operation.requestId, operation.op),
      deviceId: "ace-agent",
      payload: { type: "thread.switch", threadId: thread.id, selection },
    });
    await this.deps.engine.prepareCommand(command);
    signal.throwIfAborted();
    if (!this.authorize(caller, thread.id, true)) throw new Error("Forbidden configuration");
    return this.command(command.id, command.payload);
  }
  /**
   * The engine selection for a model (and effort, service tier) on a thread's own provider and
   * account, as configuring or forking the thread runs it. Refuses a model the catalog lacks.
   */
  async threadSelection(
    caller: McpAttribution,
    thread: import("@ace/protocol").Thread,
    requestId: string,
    model: string,
    launch: { effort?: string | undefined; serviceTier?: string | undefined } = {},
  ) {
    const identity = thread.provider === "acp" ? importAcpIdentitySchema.parse(thread) : undefined;
    const request = DelegationRequest.parse({
      requestId,
      provider: thread.provider,
      ...identity,
      instanceId: thread.execution?.instanceId ?? identity?.instanceId,
      model,
      ...(launch.effort ? { effort: launch.effort } : {}),
      ...(launch.serviceTier ? { options: { serviceTier: launch.serviceTier } } : {}),
      role: "configuration",
      task: "configure",
    });
    await this.prepareModels(caller, request);
    const filter = selectionModelFilter(thread.provider, thread.execution?.instanceId, identity);
    const selected =
      filter && this.deps.models.resolve({ role: "configuration", ...filter, model });
    if (!selected?.ok || (!isDefaultSelection(model) && !matchesModel(selected.model, model)))
      throw new AgentControlError(
        "model_unavailable",
        "Requested configuration model is unavailable",
      );
    const chosen = selectedDelegationModel(
      this.deps.models,
      request,
      thread,
      thread.execution?.instanceId,
    );
    const effort = launch.effort ? delegationEffort(chosen, request, thread) : undefined;
    const options = {
      ...(launch.serviceTier ? { serviceTier: launch.serviceTier } : {}),
      ...(effort ? { effort } : {}),
    };
    return {
      provider: thread.provider,
      model: executionModelId(chosen),
      ...(thread.execution?.instanceId ? { instanceId: thread.execution.instanceId } : {}),
      ...(Object.keys(options).length ? { options } : {}),
    };
  }
  /** Runs a thread transition (fork, merge) the way the person's client does, once prepared. */
  async transition(command: Command) {
    await this.deps.engine.prepareCommand(command);
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
  /** Starts the child now when its parent has a free slot; otherwise it waits, queued. */
  launch(record: DelegationRecord, text: string): void {
    if (this.closed || this.deps.admitsWork?.() === false)
      throw new AgentControlError("admission_closed", "Admission closed");
    this.deps.store.atomic(() => {
      const current = this.journal.get(record.childId);
      if (!current || current.phase !== "created" || this.launches.has(current.childId)) return;
      if (launchSlots(this.running(current.parentId), this.policy) > 0)
        try {
          this.start(current, text);
          return;
        } catch (error) {
          // A full engine is a wait, not a refusal: the child queues like any other.
          if (!engineFull(error)) throw error;
        }
      this.launches.add({ childId: current.childId, parentId: current.parentId, text });
      this.showQueued(current);
    });
  }
  /** Children holding the parent's run slots. */
  private running(parent: ThreadId): number {
    return this.journal.running(parent);
  }
  /** A queued child reads as waiting, so its parent never looks done while it waits. */
  private showQueued(edge: DelegationRecord): void {
    const child = this.deps.store.getThread(edge.childId);
    if (!child) return;
    const queued = { ...child, status: queuedStatus };
    this.deps.engine.updateChild(edge.parentId, queued);
    this.deps.engine.delegationStarted(edge, queued);
  }
  /** Explicit input to a queued child starts it first, regardless of free slots. */
  private launchQueued(child: ThreadId): void {
    try {
      this.deps.store.atomic(() => {
        const queued = this.launches.take(child);
        const edge = this.journal.get(child);
        if (queued && edge?.phase === "created") this.start(edge, queued.text);
      });
    } catch (error) {
      // A full engine keeps the task queued; the person's own input still goes through.
      if (!engineFull(error)) throw error;
    }
  }
  /** Fills free slots from each waiting parent's queue, oldest first. */
  private pumpAll(): void {
    if (this.closed || this.deps.admitsWork?.() === false || !this.launches.waiting()) return;
    for (const parent of this.launches.parents()) this.pump(parent);
  }
  private pump(parent: ThreadId): void {
    if (this.closed || this.deps.admitsWork?.() === false) return;
    for (const child of this.launches.next(
      parent,
      launchSlots(this.running(parent), this.policy),
    )) {
      try {
        this.deps.store.atomic(() => {
          const queued = this.launches.take(child);
          const edge = this.journal.get(child);
          if (!queued || edge?.phase !== "created") return;
          if (this.journal.fenced(child)) return this.settleUnlaunched(edge, "cancelled");
          this.start(edge, queued.text);
        });
      } catch (error) {
        // A full engine leaves the child queued for the next retry.
        if (engineFull(error)) return;
        // A child that can no longer start reports a failed result instead of waiting forever.
        this.report(error);
        const edge = this.journal.get(child);
        if (edge?.phase === "created")
          this.deps.store.atomic(() => this.settleUnlaunched(edge, "failed"));
      }
    }
  }
  /** A child that never ran settles at once: no run of its will ever end to settle it. */
  private settleUnlaunched(edge: DelegationRecord, outcome: "cancelled" | "failed"): void {
    this.launches.take(edge.childId);
    const result: DelegationOutcome = {
      threadId: edge.childId,
      outcome,
      result: outcome === "cancelled" ? "Stopped before it started." : "It could not be started.",
      truncated: false,
      before: null,
    };
    this.journal.settle(edge, result, this.deps.clock.now() + this.policy.coalesceMs);
    const thread = this.deps.store.getThread(edge.childId);
    if (thread) {
      const shown = { ...thread, status: childStatus(edge, thread) };
      this.deps.engine.updateChild(edge.parentId, shown);
      this.deps.engine.delegationStarted(edge, shown);
    }
    this.waiters.deliver(edge.childId, result);
    this.monitor.changed([edge.childId]);
  }
  private start(current: DelegationRecord, text: string): void {
    this.deps.store.atomic(() => {
      const role = current.request.role;
      const kind = role.startsWith("automation:")
        ? "automation"
        : role.startsWith("handoff:")
          ? "handoff"
          : "spawn";
      const result = this.command(controlCommandId(current.parentId, current.requestId, "launch"), {
        type: "thread.send",
        threadId: current.childId,
        input: [{ type: "text", text }],
        delivery: "queue",
        trigger: "spawn",
        origin: {
          kind,
          parentThreadId: current.parentId,
          role: current.request.role,
        },
      });
      if (!result.ok) throw controlAdmissionError(result.error ?? "Launch failed");
      // The child names its parent on the thread itself, so it survives history paging.
      if (kind === "spawn")
        this.deps.store.appendEvents(current.childId, [
          { type: "thread.updated", delegatedBy: current.parentId },
        ]);
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
  /**
   * Record `command`, a Stop of one of `thread`'s turns made by the host rather than a person
   * (an automation stopping its own run). It leaves no Stop marker on the thread, so later
   * automatic work sent to it is not held, and cancels none of the thread's children: the
   * caller stops the ones that turn started.
   */
  hostStop(thread: ThreadId, command: Command): CommandResult {
    this.suspending.add(thread);
    try {
      return this.deps.store.recordCommand(command.id, command.deviceId, () =>
        this.deps.engine.internalHandler.handle(command, commandContext(this.deps.store)),
      );
    } finally {
      this.suspending.delete(thread);
    }
  }
  /**
   * Cancel delegated work for the host (an automation stopping what its run's turn started):
   * these reservations, durably, so their preparations never commit, and these children each
   * with everything under it, by the same cascading cancel a person's Stop makes. The caller
   * passes only children whose whole subtree is its own. Their results never wake the parent,
   * as when it is stopped itself, though `hostStop` left it no Stop marker. Whether every
   * cancel was accepted.
   */
  hostCancel(
    children: readonly ThreadId[],
    reservations: readonly ThreadId[],
    request: string,
  ): boolean {
    return this.deps.store.atomic(() => {
      for (const child of reservations) {
        this.reservationLifetimes.cancelChild(child);
        const reservation = this.journal.reservationOf(child);
        if (reservation) this.journal.release(reservation);
      }
      return children
        .map((child) => {
          const edge = this.journal.get(child);
          if (!edge || edge.phase === "settled") return true;
          this.journal.suppressWake(child);
          this.cancelDescendants(child, request);
          const result = this.command(
            controlCommandId(child, `${request}:${edge.generation}`, "host.cancel"),
            { type: "thread.interrupt", threadId: child, cascade: true },
          );
          return result.ok || result.error === "thread_not_found";
        })
        .every(Boolean);
    });
  }
  /**
   * A Stop of one of a thread's agents: everything that agent and its subagents delegated is
   * cancelled with all under it, and their preparations never commit. The root's delegations
   * and other agents' go on.
   */
  cancelAgentWork(thread: ThreadId, agentId: string, request: string) {
    const agents = agentSubtree(this.deps.store, thread, agentId);
    this.deps.store.atomic(() => {
      for (const reservation of this.journal.reservations())
        if (
          reservation.record.parentId === thread &&
          agents.has(reservation.record.parentAgentId)
        ) {
          this.reservationLifetimes.cancelChild(reservation.record.childId);
          this.journal.release(reservation);
        }
      for (const edge of this.journal.liveChildren(thread)) {
        if (!agents.has(edge.parentAgentId) || edge.phase === "cancelling") continue;
        this.cancelDescendants(edge.childId, request);
        const result = this.command(
          controlCommandId(edge.childId, `${request}:${edge.generation}`, "agent.interrupt"),
          { type: "thread.interrupt", threadId: edge.childId, cascade: true },
        );
        if (!result.ok && result.error !== "thread_not_found")
          throw controlAdmissionError(result.error ?? "Stop failed");
      }
    });
    this.arm();
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
  /** A host-filtered cancellation suppresses this member's wakes without cancelling descendants. */
  cancelMember(thread: ThreadId): void {
    this.deps.store.atomic(() => {
      this.journal.stopMember(thread);
      this.journal.suppressWake(thread);
      this.journal.holdWake(thread);
      this.reservationLifetimes.cancel(thread, () => false);
      for (const reservation of this.journal.reservations())
        if (reservation.record.parentId === thread) this.journal.release(reservation);
      this.deps.engine.discardRecovery(thread);
    });
    this.arm();
  }
  /**
   * Resume what `thread` started that a daemon restart left held: its running delegated
   * children and the threads its agents opened. Each resume passes through the command policy
   * again, so their own held work follows. Only unfinished work the restart interrupted
   * qualifies: finished, stopped, settled, archived or deleted threads never start again.
   */
  private resumeRestartHeld(thread: ThreadId, request: string) {
    const started = [
      ...this.journal
        .liveChildren(thread)
        .flatMap((edge) =>
          edge.phase === "running" ? [[edge.childId, edge.generation] as const] : [],
        ),
      ...this.conversations.waitingOwnedBy(thread).map((id) => [id, 0] as const),
    ];
    for (const [child, generation] of started) {
      const queue = this.restartHeld(child);
      if (!queue) continue;
      this.command(controlCommandId(child, `${request}:${generation}`, "restart.resume"), {
        type: "thread.resume",
        threadId: child,
        expectedRevision: queue.revision,
      });
    }
  }
  /** The queue of `thread` when it is unfinished work that only a restart holds. */
  private restartHeld(thread: ThreadId) {
    const row = this.deps.store.getThread(thread);
    if (
      !row ||
      row.status.state !== "waiting" ||
      row.deletedAt !== undefined ||
      row.archivedAt !== undefined ||
      row.settledAt !== undefined ||
      this.journal.stopped(thread) ||
      this.journal.ancestorStopped(thread)
    )
      return undefined;
    const queue = this.deps.engine.queue(thread);
    return queue.paused && queue.reason === "restart" ? queue : undefined;
  }
  cancelDescendants(thread: ThreadId, request = this.deps.id()) {
    this.deps.store.atomic(() => {
      this.onRemoteCancel?.(thread);
      this.journal.cancel(thread);
      if (this.deps.store.getThread(thread)) this.deps.engine.cancelRecovery(thread);
      this.cancelPreparations(thread);
      const own = this.journal.get(thread);
      if (own?.phase === "created") this.settleUnlaunched(own, "cancelled");
      else if (own && own.phase !== "settled") {
        own.phase = "cancelling";
        this.journal.save(own);
        const child = this.deps.store.getThread(own.childId);
        if (child) this.deps.engine.delegationStarted(own, child);
      }
      const children = this.journal.liveDescendants(thread).toSorted((a, b) => b.depth - a.depth);
      for (const child of children) {
        this.journal.stop(child.childId);
        this.journal.suppressWake(child.childId);
        if (child.phase === "created") this.settleUnlaunched(child, "cancelled");
        else {
          if (this.deps.store.getThread(child.childId)) {
            this.deps.engine.discardRecovery(child.childId);
            this.deps.engine.cancelDelegatedInputs(child.childId);
          }
          child.phase = "cancelling";
          this.journal.save(child);
          const childThread = this.deps.store.getThread(child.childId);
          if (childThread) this.deps.engine.delegationStarted(child, childThread);
        }
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
    let statuses = false;
    for (const event of events) {
      statuses ||= event.payload.type === "thread.updated";
      const notice = deliveryNotice(event);
      if (notice) this.noticeParent(event.threadId, notice);
      if (event.payload.type === "run.started") this.clearDeliveredNotice(event.threadId);
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
      const participant = this.journal.participant(event.threadId);
      if (!edge && !participant) continue;
      const root = edge?.rootId ?? participant?.root_id;
      if (!root) continue;
      changed = true;
      if (event.payload.type === "run.started") {
        this.deps.store.atomic(() => {
          this.journal.account(root, event);
          if (participant) this.journal.activity(event.threadId, 1);
        });
        if (edge) this.reconcile(edge);
      } else if (event.payload.type === "usage.updated") {
        this.journal.account(root, event);
      } else {
        if (participant) this.reconcileConversation(event.threadId);
        if (edge) this.reconcile(edge);
      }
    }
    // Slots also free when admission reopens.
    if (statuses) this.pumpAll();
    if (changed) this.arm();
  }
  private reconcile(edge: DelegationRecord) {
    const thread = this.deps.store.getThread(edge.childId);
    if (!thread) return;
    this.deps.store.atomic(() => {
      if (edge.phase === "settled" && !["done", "failed", "new"].includes(thread.status.state)) {
        // Revived work always continues, whatever the counts. Only a cancelled child stays stopped.
        this.journal.revive(edge);
        if (this.journal.stopped(edge.childId) || this.journal.ancestorStopped(edge.childId)) {
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
      const shown = {
        ...thread,
        status: this.launches.has(edge.childId) ? queuedStatus : childStatus(edge, thread),
      };
      this.deps.engine.updateChild(edge.parentId, shown);
      if (edge.phase === "settled" || !["done", "failed"].includes(thread.status.state)) {
        this.deps.engine.delegationStarted(edge, shown);
        return;
      }
      const outcome = threadOutcome(this.deps.store, thread, edge.phase === "cancelling");
      this.journal.settle(edge, outcome, this.deps.clock.now() + this.policy.coalesceMs);
      this.deps.engine.delegationStarted(edge, thread);
      this.waiters.deliver(thread.id, outcome);
      // The settled child's slot goes to the next one waiting.
      this.pump(edge.parentId);
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
    const record = this.journal.get(threadId);
    const outcome =
      record?.phase === "settled" && record.outcome && thread.status.state === "new"
        ? record.outcome
        : ["done", "failed"].includes(thread.status.state)
          ? (record?.outcome ?? threadOutcome(this.deps.store, thread))
          : await this.waiters.wait(threadId, signal);
    signal.throwIfAborted();
    this.delivered(caller, outcome);
    return outcome;
  }
  /** A result the parent read inside a tool call is recorded once and never wakes it again. */
  delivered(caller: McpAttribution, outcome: DelegationOutcome) {
    const edge = this.journal.get(outcome.threadId);
    if (!edge || edge.parentId !== caller.threadId || edge.resultDelivery === "owner") return;
    this.deps.store.atomic(() => {
      this.deps.engine.delegationSettled(
        edge.parentId,
        edge.parentAgentId,
        controlCommandId(edge.parentId, `${edge.childId}:${edge.generation}`, "tool-result"),
        [outcome],
        "tool",
      );
      this.journal.consumeChild(edge.childId);
    });
  }
  private arm() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.closed) return;
    let next: ReturnType<DelegationJournal["nextWake"]>;
    try {
      next = this.journal.nextWake();
    } catch (error) {
      this.report(error);
      this.cancelTimer = this.deps.clock.setTimer(() => this.timer(), 1000);
      return;
    }
    // Queued children are retried each second, so a missed slot release only delays them.
    const poll = this.launches.waiting() ? this.deps.clock.now() + 1000 : undefined;
    const at = next && poll !== undefined ? Math.min(next.due, poll) : (next?.due ?? poll);
    if (at === undefined) return;
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
    this.pumpAll();
    for (let batch = 0; batch < 64; batch++) {
      const next = this.journal.nextWake();
      if (!next || next.due > this.deps.clock.now()) break;
      try {
        this.deps.store.atomic(() => {
          if (!this.deps.store.getThread(next.parent_id)) {
            this.journal.discard(next.parent_id);
            return;
          }
          // A stopped parent is not woken. Its results wait, undropped, for its next input.
          if (this.journal.stopped(next.parent_id) || this.journal.fenced(next.parent_id)) {
            this.journal.holdWake(next.parent_id);
            return;
          }
          if (this.deps.admitsWork?.() === false) {
            this.journal.deferWake(next.parent_id, this.deps.clock.now() + 1000);
            return;
          }
          // One page per wake; the wake stays due until every result has been delivered.
          const pending = this.journal.pending(next.parent_id);
          const delivered = pending.map((edge) => edge.childId);
          const results = pending.flatMap((edge) => (edge.outcome ? [edge.outcome] : []));
          if (!results.length) {
            this.journal.consumeDelivered(next.parent_id, delivered);
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
          // Busy parents whose provider steers get the result injected now;
          // otherwise it queues hidden from the person's queue list and runs at
          // the turn end. Never mark delivered until the send was accepted.
          const delivery = this.deps.engine.supportsSteering(next.parent_id) ? "steer" : "queue";
          const result = this.command(id, {
            type: "thread.send",
            threadId: next.parent_id,
            input: [{ type: "text", text }],
            delivery,
            trigger: "subagent_result",
            origin: { kind: "subagent_result", threadIds: pending.map((edge) => edge.childId) },
          });
          if (!result.ok) throw controlAdmissionError(result.error ?? "Launch failed");
          if (delivery === "queue") {
            try {
              this.deps.engine.prioritizeSubagentResult(next.parent_id, result.commandId);
            } catch (error) {
              this.report(error);
            }
          }
          this.journal.consumeDelivered(next.parent_id, delivered);
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
    this.monitor.close();
    this.waiters.close();
    this.unsubscribe();
    this.cancelTimer?.();
  }
}
