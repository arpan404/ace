import { EngineModels } from "./models.ts";
import { CreationAdmissions, type CreationAdmission } from "./creation-admissions.ts";
import { validateCreation } from "./creation-validation.ts";
import { workspaceDirectory } from "./workspace-directory.ts";
import { Command as CommandSchema, type PermissionMode, type CommandResult } from "@ace/protocol";
import { commandContext } from "../commands.ts";
import {
  supportsPermissionMode,
  isPermissionOption,
  limitPermissionMode as resolveChildMode,
} from "@ace/core";
import type { PermissionSettings } from "./permissions.ts";
import { z } from "zod";
import { changeEngineWorkspace } from "./workspace-change.ts";
import { ProviderKind, ThreadId } from "@ace/protocol";
import type { PrepareInput } from "./input.ts";
import { Recovery, RecoveryPreferences, type RecoveryPorts } from "./recovery.ts";
import { ContextMeters } from "./context-meter.ts";
import { recoverEngine } from "./restart.ts";
import { IntentDelivery } from "./intent-delivery.ts";
import { ThreadTransitions, type TransitionIO } from "./transitions.ts";
import { Sessions } from "./sessions.ts";
import { randomUUID } from "node:crypto";
import { deriveThreadStatus, readyForChildResults, type IdSource } from "@ace/core";
import type { CommandHandler } from "../commands.ts";
import type { Store } from "../store.ts";
import type { AgentId, Thread, Command, QueueSnapshot, QueueGet } from "@ace/protocol";
import { ThreadActor, systemClock, type EngineClock } from "./actor.ts";
import { engineLimits, type EngineLimits } from "./limits.ts";
import { IntentWorkers } from "./workers.ts";
import { engineHandler } from "./handler.ts";
import { AdapterRegistry } from "./registry.ts";
import { EngineRepository, type IntentHeader } from "./repository.ts";
export { AdapterRegistry } from "./registry.ts";
export type { EngineClock } from "./actor.ts";

export interface EngineOptions {
  models?: import("@ace/models").ModelCatalogApi;
  permissionSettings?: PermissionSettings;
  providerEnabled?(provider: import("@ace/protocol").ProviderKind, instance?: string): boolean;
  selectInstance?: (
    provider: string,
    backend?: import("@ace/engine-api").ProviderBackend,
  ) => string | undefined;
  transitions?: TransitionIO;
  prepareInput?: PrepareInput;
  recovery?: RecoveryPorts;
  preferences?: Partial<RecoveryPreferences>;
  limits?: Partial<EngineLimits>;
  beforeSend?(threadId: ThreadId, commandId: import("@ace/protocol").CommandId): Promise<void>;
  prepareWorkspace?(threadId: ThreadId): Promise<string>;
  machine?: { host: string; name: string };
  sessionContext?: NonNullable<ConstructorParameters<typeof Sessions>[0]["context"]>;
  ids?: IdSource;
  threadId?: () => string;
  commandId?: () => string;
  registry?: AdapterRegistry;
  clock?: EngineClock;
  /** Durable batching latency is independent of the status/recovery clock. */
  batchScheduler?: Pick<EngineClock, "setTimer">;
  idleMs?: number;
  silenceMs?: number;
  onError?: (error: unknown) => void;
  onProviderDiagnostic?: (thread: ThreadId, raw: import("@ace/protocol").RawPayload[]) => void;
  aceToolAction?: typeof import("@ace/mcp-server").aceToolAction;
  mcp?: (
    threadId: ThreadId,
    agentId: string,
    lifetime: AbortSignal,
  ) => NonNullable<import("@ace/engine-api").SessionContext["aceMcp"]>;
}
export class Engine {
  readonly handler: CommandHandler;
  private limits: EngineLimits;
  private nextThreadId: () => string;
  private admissions: CreationAdmissions;
  private selectInstance: EngineOptions["selectInstance"];
  private repo: EngineRepository;
  private registry: AdapterRegistry;
  private clock: EngineClock;
  private batchScheduler: Pick<EngineClock, "setTimer">;
  private idleMs: number;
  private report: (error: unknown) => void;
  private diagnostic: EngineOptions["onProviderDiagnostic"];
  private actors = new Map<ThreadId, ThreadActor>();
  private workspaceChanges = new Map<ThreadId, Promise<void>>();
  private sends: IntentWorkers;
  private controls: IntentWorkers;
  private steering: IntentWorkers;
  private sessions: Sessions;
  private recovery: Recovery;
  private meters: ContextMeters;
  private delivery: IntentDelivery;
  private transitions: ThreadTransitions;
  private readyPromise: Promise<void>;
  private readyState = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private hostInteractionHandler?: (
    command: Command,
  ) => import("@ace/protocol").CommandResult | undefined;
  private commandPolicy?: (
    command: Command,
    accept: () => import("@ace/protocol").CommandResult,
  ) => import("@ace/protocol").CommandResult;
  constructor(store: Store, options: EngineOptions = {}) {
    this.limits = engineLimits(options.limits);
    this.nextThreadId = options.threadId ?? randomUUID;
    this.repo = new EngineRepository(
      store,
      options.ids,
      this.limits.maxActiveThreads,
      options.commandId,
      options.aceToolAction,
    );
    const models = new EngineModels(this.repo, () => this.clock.now(), options.models);
    this.admissions = new CreationAdmissions(this.repo, this.nextThreadId);
    this.selectInstance = options.selectInstance;
    this.registry = options.registry ?? new AdapterRegistry();
    this.clock = options.clock ?? systemClock;
    this.batchScheduler = options.batchScheduler ?? systemClock;
    this.idleMs = options.idleMs ?? 30 * 60_000;
    const silenceMs = options.silenceMs ?? 60_000;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 0) throw new Error("Invalid idleMs");
    if (!Number.isSafeInteger(silenceMs) || silenceMs < 0) throw new Error("Invalid silenceMs");
    this.report = options.onError ?? console.error;
    this.diagnostic = options.onProviderDiagnostic;
    this.sends = new IntentWorkers((id) => this.work(this.actor(id)), this.report);
    this.steering = new IntentWorkers((id) => this.steer(this.actor(id)), this.report);
    this.controls = new IntentWorkers((id) => this.control(this.actor(id)), this.report);
    this.sessions = new Sessions({
      models,
      ...(options.mcp ? { mcp: options.mcp } : {}),
      ...(options.sessionContext ? { context: options.sessionContext } : {}),
      repo: this.repo,
      ...(options.permissionSettings ? { permissionSettings: options.permissionSettings } : {}),
      ...(options.prepareWorkspace ? { prepareWorkspace: options.prepareWorkspace } : {}),
      registry: this.registry,
      clock: this.clock,
      closing: () => this.closing,
      wake: (id) => this.wake(id),
      expireDelivery: (actor) => this.delivery.expire(actor),
      released: (id) => {
        this.releaseDormant(id);
        this.wakeQueued();
      },
    });
    this.recovery = new Recovery(
      this.repo,
      this.clock,
      options.recovery ?? {},
      RecoveryPreferences.parse(options.preferences ?? {}),
      (id) => this.wake(id),
    );
    this.transitions = new ThreadTransitions(
      this.repo,
      this.registry,
      this.sessions,
      options.transitions ?? {
        migrate: async () => ({ status: "refused", reason: "Accounts migration is unavailable" }),
        applyPatch: async () => {
          throw new Error("Git service is unavailable");
        },
      },
      () => this.clock.now(),
      models,
      async (id) => {
        const target = this.actor(id);
        await target.flush();
        if (!this.repo.quiescent(this.repo.requireState(id)))
          throw new Error("Transition tree became live");
        await this.sessions.close(target, "idle");
        if (!this.repo.quiescent(this.repo.requireState(id)))
          throw new Error("Transition tree has unsettled work");
      },
    );
    this.delivery = new IntentDelivery({
      repo: this.repo,
      clock: this.clock,
      registry: this.registry,
      sessions: this.sessions,
      recovery: this.recovery,
      prepareInput: options.prepareInput,
      beforeSend: options.beforeSend,
      transitions: this.transitions,
      invalidateContext: (id) => this.meters.invalidate(id, this.clock.now()),
      releaseGuards: (intent) => {
        for (const id of this.repo.transitions.releaseGuards(intent.commandId)) {
          this.releaseDormant(id);
          queueMicrotask(() => this.wake(id));
        }
      },
      isSteer: (intent) => this.isSteer(intent),
    });
    this.meters = new ContextMeters(store, options.recovery?.contextWindow);
    this.repo.observe = (state, facts, events, at) => {
      this.repo.permissions.observe(state, events, at, () => this.wake(state.threadId));
      if (facts.some((fact) => fact.type === "process.started"))
        this.meters.invalidate(state.threadId, at);
      if (
        events.some(
          (event) =>
            event.type === "usage.updated" ||
            event.type === "context.sampled" ||
            (event.type === "agent.updated" && event.model !== undefined) ||
            ((event.type === "item.created" || event.type === "item.updated") &&
              event.item.type === "compaction") ||
            (event.type === "agent.status" &&
              event.status.state === "working" &&
              event.status.activity === "compacting"),
        )
      )
        this.meters.observe(state, events, at, this.repo.session(state.threadId).instanceId);
      this.actors.get(state.threadId)?.observeInputs(events);
      this.recovery.observe(state, facts, events, at);
    };
    const handler = engineHandler(
      this.repo,
      this.registry,
      () => this.clock.now(),
      silenceMs,
      (id) => this.wake(id),
      options.threadId ?? randomUUID,
      this.recovery,
      this.limits,
      this.admissions,
      workspaceDirectory,
      options.selectInstance,
      options.machine,
      options.providerEnabled,
      models,
    );
    this.handler = {
      handle: (command, context) =>
        permissionOptions(command)
          ? { commandId: command.id, ok: false, error: "provider_permission_options_forbidden" }
          : this.closing
            ? { commandId: command.id, ok: false, error: "daemon_shutting_down" }
            : !this.readyState
              ? { commandId: command.id, ok: false, error: "engine_starting" }
              : store.atomic(
                  () =>
                    this.hostInteractionHandler?.(command) ??
                    (this.commandPolicy
                      ? this.commandPolicy(command, () => handler.handle(command, context))
                      : handler.handle(command, context)),
                ),
    };
    const recover = () =>
      recoverEngine(
        this.repo,
        this.recovery,
        this.clock,
        (intent, message) => this.delivery.fail(intent, message),
        (id) => this.wake(id),
      );
    const recovery = this.recovery;
    const repo = this.repo;
    if (options.recovery?.preferences || options.models) {
      this.readyPromise = (async () => {
        await recovery.prepare();
        for (const state of repo.states()) await recovery.prepare(state.threadId);
        models.migrateCachedDefaults();
        if (!this.closing) recover();
        this.readyState = true;
      })();
    } else {
      recover();
      this.readyState = true;
      this.readyPromise = Promise.resolve();
    }
  }
  /** One trusted host policy for accepted commands, inside the receipt transaction. */
  bindCommandPolicy(policy: NonNullable<Engine["commandPolicy"]>): void {
    this.commandPolicy = policy;
  }
  private flushDepth = 0;
  private actor(id: ThreadId): ThreadActor {
    let actor = this.actors.get(id);
    if (!actor) {
      for (const [key, cached] of this.actors) {
        if (this.actors.size < this.limits.maxActiveThreads) break;
        if (!this.repo.reservedSlot(key)) {
          cached.stop();
          this.repo.evict(key);
          this.actors.delete(key);
        }
      }
      if (this.actors.size >= this.limits.maxActiveThreads)
        throw new Error("Engine actor capacity exceeded");
      actor = new ThreadActor(
        id,
        this.repo,
        this.clock,
        this.idleMs,
        () => this.wake(id),
        this.report,
        this.limits,
        () => this.flushDepth > 0,
        this.batchScheduler,
        this.diagnostic,
      );
      this.actors.set(id, actor);
    }
    return actor;
  }
  providerAvailability(provider: ProviderKind) {
    const { installed, auth } = this.registry.get(provider).discovery;
    return { installed, auth };
  }
  capabilities(provider: ProviderKind, backend?: import("@ace/engine-api").ProviderBackend) {
    return structuredClone(this.registry.get(provider, backend).capabilities);
  }
  /** Trusted spawn boundary for Deck and delegation. Receipt identity is caller-owned. */
  spawn(
    command: Command,
    scope: { permissionMode?: PermissionMode; parentThreadId?: ThreadId } = {},
  ): CommandResult {
    const p = command.payload;
    if (p.type !== "thread.create" && p.type !== "thread.prepare")
      throw new Error("Spawn requires thread.create or thread.prepare");
    const id = p.threadId ?? ThreadId.parse(this.nextThreadId());
    const requested = scope.permissionMode ?? p.permissionMode;
    return this.repo.store.recordCommand(command.id, command.deviceId, () =>
      this.repo.store.atomic(() => {
        if (this.repo.store.getThread(id))
          return { commandId: command.id, ok: false, error: "thread_exists" };
        if (permissionOptions(command))
          return {
            commandId: command.id,
            ok: false,
            error: "provider_permission_options_forbidden",
          };
        if (scope.parentThreadId && !this.repo.state(scope.parentThreadId))
          return { commandId: command.id, ok: false, error: "permission_parent_not_found" };
        if (requested || scope.parentThreadId) {
          const ceiling = scope.parentThreadId
            ? this.repo.permissions.authority(scope.parentThreadId)
            : undefined;
          if (requested && ceiling && resolveChildMode(requested, ceiling) !== requested)
            return { commandId: command.id, ok: false, error: "permission_exceeds_parent" };
          const selected = requested ?? ceiling;
          if (
            selected &&
            !supportsPermissionMode(
              this.registry.get(p.provider).capabilities.permissions,
              selected,
            )
          )
            return { commandId: command.id, ok: false, error: "permission_mode_unsupported" };
        }
        const payload = { ...p, threadId: id, ...(requested ? { permissionMode: requested } : {}) };
        const result = this.handler.handle(
          CommandSchema.parse({ ...command, payload }),
          commandContext(this.repo.store),
        );
        if (result.ok && scope.parentThreadId)
          this.repo.permissions.parent(id, scope.parentThreadId, this.clock.now());
        return result;
      }),
    );
  }
  permissionAuthority(id: ThreadId): PermissionMode {
    return this.repo.permissions.authority(id);
  }
  permissionMode(id: ThreadId): PermissionMode {
    return this.repo.permissions.effective(id);
  }
  /** Host-owned summary attachment. Child transcript and native session stay independent. */
  attachChild(
    parentId: ThreadId,
    parentAgentId: AgentId,
    child: Thread,
    role: string,
    background: boolean,
  ): void {
    this.repo.permissions.parent(child.id, parentId, this.clock.now());
    const state = this.repo.requireState(parentId);
    const parent = state.indexes.agentKeysById[parentAgentId];
    if (!parent) throw new Error("Unknown parent agent");
    this.repo.apply(
      parentId,
      [
        {
          type: "agent.seen",
          agent: `ace-child:${child.id}`,
          parent,
          origin: "ace",
          fidelity: "summary",
          native: { provider: child.provider },
          cwd: this.repo.session(child.id).cwd,
          role,
          background,
        },
        {
          type: "agent.external",
          agent: `ace-child:${child.id}`,
          threadId: child.id,
          status: child.status,
        },
      ],
      this.clock.now(),
    );
  }
  updateChild(parentId: ThreadId, child: Thread): void {
    this.repo.apply(
      parentId,
      [
        {
          type: "agent.external",
          agent: `ace-child:${child.id}`,
          threadId: child.id,
          status: child.status,
        },
      ],
      this.clock.now(),
    );
    this.wake(parentId);
  }
  /** One stable parent item follows each independently owned child thread. */
  delegationStarted(record: import("@ace/protocol").DelegationRecord, child: Thread) {
    const state = this.repo.requireState(record.parentId);
    const agent = state.indexes.agentKeysById[record.parentAgentId];
    if (!agent) throw new Error("Unknown delegation parent");
    const selection = this.repo.session(child.id);
    this.repo.apply(
      record.parentId,
      [
        {
          type: "item.upsert",
          agent,
          item: `ace-delegation:${child.id}`,
          draft: {
            type: "delegation.started",
            origin: "ace",
            childThreadId: child.id,
            provider: child.provider,
            ...(selection.model ? { model: selection.model } : {}),
            ...(selection.instanceId ? { accountId: selection.instanceId } : {}),
            title: child.title,
            role: record.request.role,
            phase: record.phase,
            status: child.status,
            updatedAt: this.clock.now(),
            generation: record.generation,
            complete: record.phase === "settled",
            outcome: record.outcome ?? null,
          },
        },
      ],
      this.clock.now(),
    );
  }
  /** Host-only result attribution; ordinary wire sends cannot impersonate ace. */
  delegationSettled(
    parentId: ThreadId,
    parentAgentId: AgentId,
    commandId: string,
    results: import("@ace/protocol").DelegationOutcome[],
    delivery: "tool" | "ace-input",
    text?: string,
  ) {
    const state = this.repo.requireState(parentId);
    const agent = state.indexes.agentKeysById[parentAgentId];
    if (!agent) throw new Error("Unknown delegation parent");
    const item = `ace-results:${commandId}`;
    const summaries = results.map((result) => ({
      ...result,
      result: result.result.slice(0, 128),
      truncated: result.truncated || result.result.length > 128,
    }));
    this.repo.store.atomic(() => {
      if (text)
        this.repo.aceInputs.record(parentId, commandId, { agent, item, results: summaries });
      this.repo.apply(
        parentId,
        [
          {
            type: "item.upsert",
            agent,
            item,
            draft: {
              type: "delegation.settled",
              origin: "ace",
              delivery,
              results: summaries,
              complete: true,
            },
          },
        ],
        this.clock.now(),
      );
    });
  }
  /** On-demand metrics visit bounded live actors and indexed outstanding intents only. */
  workload(): { activeSessions: number; queues: Record<string, number> } {
    let activeSessions = 0;
    const queues = { "engine.frames": 0, "engine.frameBytes": 0, "engine.queuedSends": 0 };
    for (const actor of this.actors.values()) {
      if (actor.session) activeSessions++;
      const backlog = actor.backlog();
      queues["engine.frames"] += backlog.frames;
      queues["engine.frameBytes"] += backlog.bytes;
      queues["engine.queuedSends"] += this.repo.queuedCount(actor.id);
    }
    return { activeSessions, queues };
  }
  bindHostInteractions(
    handler: (command: Command) => import("@ace/protocol").CommandResult | undefined,
  ): void {
    const previous = this.hostInteractionHandler;
    this.hostInteractionHandler = (command) => handler(command) ?? previous?.(command);
  }
  /**
   * A thread's root agent id. A prepared thread has only its configured root until a fact
   * arrives, so a harmless tick materializes it for hosts that attach children before any turn.
   */
  rootAgent(threadId: ThreadId): string | undefined {
    const rootOf = () => {
      const state = this.repo.requireState(threadId);
      return state.rootKey === undefined ? undefined : state.agents[state.rootKey]?.agent.id;
    };
    if (rootOf() === undefined) this.actor(threadId).apply([{ type: "tick" }]);
    return rootOf();
  }
  openHostApproval(
    threadId: ThreadId,
    key: string,
    request: import("@ace/protocol").InteractionRequest,
    raw: import("@ace/protocol").RawPayload[],
  ) {
    const state = this.repo.requireState(threadId);
    this.actor(threadId).apply([
      {
        type: "interaction.opened",
        agent: state.rootKey ?? "root",
        interaction: key,
        blocking: true,
        request,
        raw,
      },
    ]);
    const interaction = this.repo.requireState(threadId).interactions[key];
    if (!interaction) throw new Error("Host interaction was not admitted");
    return interaction.id;
  }
  resolveHostApproval(
    threadId: ThreadId,
    key: string,
    result: {
      state: "resolved" | "cancelled" | "expired";
      resolution?: import("@ace/protocol").InteractionResolution;
      resolvedBy?: import("@ace/protocol").DeviceId;
    },
  ): void {
    this.actor(threadId).apply([{ type: "interaction.closed", interaction: key, ...result }]);
  }
  openHostGate(threadId: ThreadId, key: string, message: string) {
    return this.openHostApproval(
      threadId,
      key,
      { kind: "plan_review", title: "Deck needs your decision", markdown: message },
      [{ type: "ace.conductor.gate", data: { key } }],
    );
  }
  closeHostGate(threadId: ThreadId, key: string, state: "resolved" | "cancelled"): void {
    this.resolveHostApproval(threadId, key, { state });
  }
  activeExecutionSelections() {
    const row = z.object({
      thread_id: ThreadId,
      provider: ProviderKind,
      instance_id: z.string().nullable(),
    });
    return this.repo.store
      .atomic((db) =>
        db
          .prepare(`SELECT s.thread_id,t.provider,s.instance_id FROM threads t JOIN engine_sessions s ON s.thread_id=t.id
      WHERE s.native_session_id IS NOT NULL AND json_extract(t.status,'$.state') NOT IN ('new','done','failed') LIMIT 65`)
          .all(),
      )
      .map((value) => row.parse(value));
  }
  /** Host suspension captures the engine-owned continuation before interrupting work. */
  discardRecovery(id: ThreadId): void {
    this.recovery.discard(id);
  }
  captureContinuation(id: ThreadId): void {
    this.recovery.capture(id);
  }
  async changeWorkspace(
    id: ThreadId,
    commandId: string,
    effect: () => Promise<import("@ace/protocol").ThreadDetails>,
    reservation: { roots: readonly string[]; hasOwnedWork(id: ThreadId): boolean } = {
      roots: [this.repo.session(id).cwd],
      hasOwnedWork: () => false,
    },
  ): Promise<void> {
    if (this.closing || this.workspaceChanges.has(id))
      throw new Error("workspace_change_in_progress");
    const change = changeEngineWorkspace(
      this.repo,
      id,
      commandId,
      () => this.clock.now(),
      async (owner) => {
        const actor = this.actor(owner);
        await actor.flush();
        await this.sessions.close(actor, "idle");
        await actor.flush();
      },
      effect,
      (owner) => this.wake(owner),
      { ...reservation, roots: [...reservation.roots, this.repo.session(id).cwd] },
    ).finally(() => this.workspaceChanges.delete(id));
    this.workspaceChanges.set(id, change);
    return change;
  }
  sessionMetadata(id: ThreadId) {
    return this.repo.session(id);
  }
  commandExecution(commandId: import("@ace/protocol").CommandId) {
    return this.repo.pending.commandStatus(commandId);
  }
  queuePage(request: Pick<QueueGet, "threadId" | "after" | "expectedRevision" | "limit">) {
    return this.repo.queue.page(request);
  }
  retainsAttachment(id: ThreadId, hash: string): boolean {
    return this.repo.queue.retains(id, hash);
  }
  ready(): Promise<void> {
    return this.readyPromise;
  }
  /** Validate before Git I/O and hold an engine slot until acceptance or cancellation. */
  admitCreation(command: Command): CreationAdmission | string {
    if (permissionOptions(command)) return "provider_permission_options_forbidden";
    if (this.closing) return "daemon_shutting_down";
    if (!this.readyState) return "engine_starting";
    const validation = validateCreation(
      command,
      this.repo,
      this.registry,
      this.limits,
      workspaceDirectory,
      this.selectInstance,
    );
    if (!validation.ok) return validation.error;
    return this.admissions.acquire(command);
  }
  async prepareCommand(command: Command): Promise<void> {
    await this.readyPromise;
    if (
      !["thread.create", "thread.send", "thread.resume", "queue.resume", "thread.limit"].includes(
        command.payload.type,
      )
    )
      return;
    await this.recovery.prepare(
      "threadId" in command.payload && command.payload.threadId
        ? ThreadId.parse(command.payload.threadId)
        : undefined,
    );
  }
  queue(id: ThreadId): QueueSnapshot {
    return this.repo.queue.snapshot(id);
  }

  private wakeQueued(): void {
    if (this.closing) return;
    for (const id of this.repo.pending.runnableThreads(this.limits.maxActiveThreads))
      if (this.repo.reserve(id)) this.wake(id);
  }
  private releaseDormant(id: ThreadId): void {
    const actor = this.actors.get(id);
    if (
      actor?.session ||
      this.sessions.isClosing(id) ||
      this.repo.sessionOpening(id) ||
      this.repo.pending.running(id)
    )
      return;
    const queue = this.repo.queue.get(id);
    if (
      this.repo.pending.recovery(id) ||
      this.repo.pending.transition(id) ||
      this.repo.pending.controls(id).length ||
      (!queue.paused && !queue.limited && this.repo.pending.message(id))
    )
      return;
    if (this.repo.reservedSlot(id)) {
      this.repo.release(id);
      this.wakeQueued();
    }
  }
  private deferredWakes = new Set<ThreadId>();
  private wake(id: ThreadId): void {
    if (this.closing) return;
    if (this.repo.store.isHistoryWriting()) {
      if (!this.deferredWakes.has(id)) {
        this.deferredWakes.add(id);
        void this.repo.store
          .writable()
          .then(() => {
            this.deferredWakes.delete(id);
            this.wake(id);
          })
          .catch(this.report);
      }
      return;
    }
    this.releaseDormant(id);
    if (!this.repo.reservedSlot(id)) return;
    this.sends.wake(id);
    this.controls.wake(id);
    this.steering.wake(id);
  }
  private async control(actor: ThreadActor): Promise<void> {
    await actor.flush();
    if (actor.poisoned) return;
    if (actor.idleDue && actor.session) await this.sessions.close(actor, "idle");
    if (
      !actor.session &&
      (this.repo.pending.message(actor.id) || this.repo.pending.recovery(actor.id))
    )
      return;
    const controls = this.repo.pending.controls(actor.id);
    for (const intent of controls) {
      if (this.closing) return;
      const guard = this.repo.transitions.guardOwner(actor.id);
      if (guard && guard !== intent.commandId) continue;
      await this.delivery.run(actor, intent);
    }
    this.releaseDormant(actor.id);
    if (controls.length === 64) this.wake(actor.id);
  }
  private syncQueue(actor: ThreadActor): void {
    actor.syncQueue();
  }
  private async work(actor: ThreadActor): Promise<void> {
    await actor.flush();
    if (actor.poisoned) {
      if (actor.session) await this.sessions.close(actor, "user");
      for (const intent of this.repo.pending.headers(actor.id))
        if (["pending", "queued"].includes(intent.status))
          this.delivery.fail(
            intent,
            "Thread stopped after a persistence failure; restart the daemon before retrying",
          );
      this.syncQueue(actor);
      return;
    }
    if (this.repo.store.workspaceReservations.reserved(this.repo.session(actor.id).cwd)) return;
    // Controls own idle retirement; sends must remain free to open a replacement.
    if (this.closing || (actor.idleDue && actor.session)) return;
    const guard = this.repo.transitions.guardOwner(actor.id);
    const change = this.repo.pending.transition(actor.id);
    if (
      change &&
      (!guard || guard === change.commandId) &&
      !this.repo.pending.awaiting(actor.id) &&
      !this.repo.pending.recovering(actor.id) &&
      this.repo.quiescent(this.repo.requireState(actor.id))
    ) {
      await this.delivery.run(actor, change);
      this.wake(actor.id);
      return;
    }
    const recovery = this.repo.pending.recovery(actor.id);
    const queue = this.repo.queue.get(actor.id);
    // Releasing a restart hold does not consume native history. Keep the fork or
    // patch guard until its owning transition executes after this explicit resume.
    if (
      recovery &&
      (!guard ||
        guard === recovery.commandId ||
        (!queue.continuation && ["thread.resume", "queue.resume"].includes(recovery.kind)))
    ) {
      await this.delivery.run(actor, recovery);
      this.wake(actor.id);
      return;
    }
    if (this.repo.pending.recoveryAcknowledgement(actor.id)) return;
    if (queue.paused || queue.limited) {
      this.releaseDormant(actor.id);
      actor.schedule();
      return;
    }
    const first = this.repo.pending.message(actor.id);
    const intent =
      first && ["thread.switch", "thread.merge"].includes(first.kind)
        ? this.repo.pending.childResult(actor.id)
        : first && this.isSteer(first)
          ? this.repo.pending.queuedMessage(actor.id)
          : first;
    if (
      intent &&
      (!guard || guard === intent.commandId) &&
      !["thread.switch", "thread.merge"].includes(intent.kind)
    ) {
      this.repo.mark(intent, "queued");
      this.syncQueue(actor);
      const state = this.repo.requireState(actor.id);
      const status = deriveThreadStatus({ ...state, queueCount: state.queueSources.provider });
      const ready =
        intent.trigger === "subagent_result"
          ? readyForChildResults(state)
          : ["new", "done", "failed"].includes(status.state) || this.repo.quiescent(state);
      if (!this.repo.pending.awaiting(actor.id) && ready) {
        await this.delivery.run(actor, intent);
        this.wake(actor.id);
        return;
      }
    }
    this.releaseDormant(actor.id);
    actor.schedule();
  }
  private isSteer(intent: IntentHeader): boolean {
    if (intent.kind !== "thread.send" || intent.delivery !== "steer") return false;
    if (this.repo.transitions.guarded(intent.threadId)) return false;
    const state = this.repo.requireState(intent.threadId);
    if (
      this.repo.pending.transition(intent.threadId) &&
      (this.repo.pending.running(intent.threadId) || this.repo.quiescent(state))
    )
      return false;
    return (
      Boolean(this.actors.get(intent.threadId)?.session) &&
      !this.repo.queue.get(intent.threadId).paused &&
      !this.repo.queue.get(intent.threadId).limited &&
      !this.repo.pending.recovering(intent.threadId) &&
      this.registry.has(state.config.provider) &&
      (
        this.actors.get(intent.threadId)?.effectiveCapabilities ??
        this.registry.get(state.config.provider, this.repo.backend(intent.threadId)).capabilities
      ).steer
    );
  }
  private async steer(actor: ThreadActor): Promise<void> {
    await actor.flush();
    if (actor.poisoned || this.closing || !actor.session) return;
    const queue = this.repo.queue.get(actor.id);
    if (queue.paused || queue.limited) return;
    const intent = this.repo.pending.steerMessage(actor.id);
    if (intent && this.isSteer(intent)) {
      await this.delivery.run(actor, intent);
      this.wake(actor.id);
    }
  }
  /** Read the original JSON bytes of an oversized raw payload's data envelope. */
  readRawBlob(id: string): Uint8Array | undefined {
    return this.repo.readRawBlob(id);
  }
  /** Drain accepted commands and frames. Does not wait for queued work to become runnable. */
  async flush(): Promise<void> {
    this.flushDepth++;
    try {
      await this.readyPromise;
      await Promise.resolve();
      do {
        await Promise.all([...this.actors.values()].map((actor) => actor.flush()));
        await Promise.all([this.sends.flush(), this.controls.flush(), this.steering.flush()]);
        await Promise.all([...this.actors.values()].map((actor) => actor.flush()));
        await this.recovery.flush();
      } while (this.sends.active || this.controls.active || this.steering.active);
    } finally {
      this.flushDepth--;
    }
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
      this.flushDepth++;
      await Promise.allSettled(this.workspaceChanges.values());
      await this.readyPromise;
      this.recovery.close();
      for (const actor of this.actors.values()) {
        await actor.flush();
        this.recovery.capture(actor.id);
      }
      this.sends.stop();
      this.controls.stop();
      this.steering.stop();
      for (const actor of this.actors.values()) {
        if (!actor.session) actor.lifetime?.abort();
      }
      await Promise.all(
        [...this.actors.values()].map(async (actor) => {
          try {
            await this.sessions.close(actor, "shutdown");
          } catch (error) {
            this.report(error);
          }
        }),
      );
      for (const actor of this.actors.values()) {
        await actor.flush();
        actor.stop();
        actor.lifetime?.abort();
      }
      await this.flush();
    })();
    return this.closePromise;
  }
}

function permissionOptions(command: Command): boolean {
  const p = command.payload;
  const options =
    "selection" in p && p.selection ? p.selection.options : "options" in p ? p.options : undefined;
  return Object.keys(options ?? {}).some((key) => isPermissionOption(key));
}
