import {
  PermissionPolicyIdentity as importPermissionPolicyIdentity,
  AcpIdentity as importAcpIdentity,
} from "@ace/protocol";
import { liveAceCall } from "./ace-approvals.ts";
import { adoptImportedThread } from "./imported-thread.ts";
import { ThreadLiveness, type LiveWork } from "./thread-liveness.ts";
import { reclaimIdleSlot } from "./slot-reclaim.ts";
import { EngineModels } from "./models.ts";
import { personCommand } from "./person-command.ts";
import { cancelDelegatedInputs } from "./stop-intents.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nameWorktreeBranch, runWorktreeGit, type WorktreeGit } from "./worktree-title.ts";
import { CreationAdmissions, type CreationAdmission } from "./creation-admissions.ts";
import { validateCreation } from "./creation-validation.ts";
import { workspaceDirectory } from "./workspace-directory.ts";
import {
  AccessMode,
  Command as CommandSchema,
  type AccessModeOffer,
  type AccessRequest,
  type CommandResult,
} from "@ace/protocol";
import { commandContext } from "../commands.ts";
import { AccessError, type PermissionSettings } from "./permissions.ts";
import { reportedOrTable } from "@ace/provider-kit/access-modes";
import { changeEngineWorkspace, type WorkspaceChangeReservation } from "./workspace-change.ts";
import { ProviderKind, ThreadId } from "@ace/protocol";
import type { PrepareInput } from "./input.ts";
import { Recovery, RecoveryPreferences, type RecoveryPorts } from "./recovery.ts";
import { ContextMeters } from "./context-meter.ts";
import { recoverEngine } from "./restart.ts";
import { DelegationFacts } from "./delegation-facts.ts";
import { continuesNatively, heldInterrupted } from "./restart-eligibility.ts";
import { IntentDelivery } from "./intent-delivery.ts";
import { ThreadTransitions, type TransitionIO } from "./transitions.ts";
import { Sessions } from "./sessions.ts";
import { timeOrderedIds } from "../time-ordered-id.ts";
import { deriveThreadStatus, readyForChildResults, type IdSource } from "@ace/core";
import { SteerLane } from "./steer-lane.ts";
import { rootRun } from "./steer-yield.ts";
import type { CommandHandler } from "../commands.ts";
import type { Store } from "../store.ts";
import type { AgentId, Thread, Command, QueueSnapshot, QueueGet } from "@ace/protocol";
import { ThreadActor, systemClock, type EngineClock } from "./actor.ts";
import { engineLimits, type EngineLimits } from "./limits.ts";
import { IntentWorkers } from "./workers.ts";
import { engineHandler } from "./handler.ts";
import { inputFate, type InputFate } from "./input-fate.ts";
import { AdapterRegistry } from "./registry.ts";
import { EngineRepository, type IntentHeader } from "./repository.ts";
import { SettledTrees } from "./settled-trees.ts";
import {
  defaultProviderIdleMs,
  providerProcessState,
  releaseRequest,
  releasedThread,
  type ProviderProcess,
} from "./provider-release.ts";
export { AdapterRegistry } from "./registry.ts";
export type { EngineClock } from "./actor.ts";

export interface EngineOptions {
  waitForProvider?(provider: import("@ace/protocol").ProviderKind): Promise<void>;
  onModelUnavailable?(
    provider: import("@ace/protocol").ProviderKind,
    model: string,
    instance?: string,
  ): void;
  onCommandEvent?(event: import("./provider-command-metadata.ts").ProviderCommandEvent): void;
  models?: import("@ace/models").ModelCatalogApi;
  worktreeGit?: WorktreeGit;
  /** The person's message that named a thread, for generating its title once. */
  onNamingPrompt?(threadId: ThreadId, input: readonly import("@ace/protocol").ContentPart[]): void;
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
  /** `runCommands` is false when the thread's access is Read-only: no setup script runs. */
  prepareWorkspace?(threadId: ThreadId, options: { runCommands: boolean }): Promise<string>;
  assertWorkspaceAvailable?(cwd: string): Promise<void>;
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
  /** Stopping part of a settled thread's tree failed: for the log only, never the person. */
  onSettleCleanupFailure?: (thread: ThreadId, error: unknown) => void;
  onSessionOpenFailure?: (
    thread: ThreadId,
    details: import("@ace/protocol").ProviderErrorDetails,
    route?: import("./session-open-route.ts").SessionOpenRoute,
  ) => void;
  onProviderDiagnostic?: (thread: ThreadId, raw: import("@ace/protocol").RawPayload[]) => void;
  aceToolAction?: typeof import("@ace/mcp-server").aceToolAction;
  mcp?: (
    threadId: ThreadId,
    agentId: string,
    lifetime: AbortSignal,
  ) => NonNullable<import("@ace/engine-api").SessionContext["aceMcp"]>;
}
export class Engine {
  private readonly models: EngineModels;
  private readonly waitForProvider: EngineOptions["waitForProvider"];
  readonly handler: CommandHandler;
  /** In-process admission for ace-owned inputs; never installed on the socket. */
  readonly internalHandler: CommandHandler;
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
  private settleFailed: (thread: ThreadId, error: unknown) => void;
  private settledTrees: SettledTrees;
  /** Settles that arrived before startup recovery finished; stopped once it has. */
  private pendingSettles = new Set<ThreadId>();
  private diagnostic: EngineOptions["onProviderDiagnostic"];
  private actors = new Map<ThreadId, ThreadActor>();
  private stopReleaseWatch: () => void;
  private workspaceChanges = new Map<ThreadId, Promise<void>>();
  private sends: IntentWorkers;
  private controls: IntentWorkers;
  private steering: IntentWorkers;
  private steerLane: SteerLane;
  private sessions: Sessions;
  private recovery: Recovery;
  private meters: ContextMeters;
  private delivery: IntentDelivery;
  private transitions: ThreadTransitions;
  private liveness: ThreadLiveness;
  private delegationFacts: DelegationFacts;
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
    this.waitForProvider = options.waitForProvider;
    this.limits = engineLimits(options.limits);
    const executeGit = promisify(execFile);
    const worktreeGit =
      options.worktreeGit ?? ((cwd, args) => runWorktreeGit(executeGit, process.env, cwd, args));
    this.nextThreadId = options.threadId ?? timeOrderedIds();
    this.clock = options.clock ?? systemClock;
    this.repo = new EngineRepository(
      store,
      options.ids,
      this.limits.maxActiveThreads,
      options.commandId,
      options.aceToolAction,
      () => this.clock.now(),
    );
    if (options.onNamingPrompt) this.repo.onNamingPrompt = options.onNamingPrompt;
    this.repo.reclaim = (retiring) =>
      reclaimIdleSlot(
        {
          repo: this.repo,
          actors: () => this.actors.entries(),
          closing: (id) => this.sessions.isClosing(id),
          retire: (id) => this.controls.wake(id),
        },
        retiring,
      );
    const models = (this.models = new EngineModels(
      this.repo,
      () => this.clock.now(),
      options.models,
      options.onModelUnavailable,
    ));
    this.admissions = new CreationAdmissions(this.repo, this.nextThreadId);
    this.selectInstance = options.selectInstance;
    this.registry = options.registry ?? new AdapterRegistry();
    this.batchScheduler = options.batchScheduler ?? systemClock;
    this.idleMs = options.idleMs ?? defaultProviderIdleMs;
    const silenceMs = options.silenceMs ?? 60_000;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 0) throw new Error("Invalid idleMs");
    if (!Number.isSafeInteger(silenceMs) || silenceMs < 0) throw new Error("Invalid silenceMs");
    this.report = options.onError ?? console.error;
    this.settleFailed = options.onSettleCleanupFailure ?? ((_thread, error) => this.report(error));
    this.diagnostic = options.onProviderDiagnostic;
    this.sends = new IntentWorkers((id) => this.slotted(id, (a) => this.work(a)), this.report);
    this.steering = new IntentWorkers((id) => this.slotted(id, (a) => this.steer(a)), this.report);
    this.controls = new IntentWorkers(
      (id) => this.slotted(id, (a) => this.control(a)),
      this.report,
    );
    this.sessions = new Sessions({
      models,
      ...(options.waitForProvider ? { waitForProvider: options.waitForProvider } : {}),
      ...(options.onCommandEvent ? { commandEvent: options.onCommandEvent } : {}),
      ...(options.mcp ? { mcp: options.mcp } : {}),
      ...(options.sessionContext ? { context: options.sessionContext } : {}),
      repo: this.repo,
      ...(options.onSessionOpenFailure ? { openFailed: options.onSessionOpenFailure } : {}),
      ...(options.permissionSettings ? { permissionSettings: options.permissionSettings } : {}),
      ...(options.prepareWorkspace ? { prepareWorkspace: options.prepareWorkspace } : {}),
      ...(options.assertWorkspaceAvailable
        ? { assertWorkspaceAvailable: options.assertWorkspaceAvailable }
        : {}),
      registry: this.registry,
      clock: this.clock,
      closing: () => this.closing,
      wake: (id) => this.wake(id),
      released: (id) => {
        this.releaseDormant(id);
        this.wakeQueued();
      },
      interrupted: (id) => this.recovery.holdInterrupted(id),
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
      beforeSend: async (threadId, commandId) => {
        await nameWorktreeBranch(this.repo.store, threadId, this.clock.now(), worktreeGit);
        await options.beforeSend?.(threadId, commandId);
      },
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
    this.steerLane = new SteerLane({
      repo: this.repo,
      registry: this.registry,
      actor: (id) => this.actors.get(id),
      deliver: (actor, intent) => this.delivery.run(actor, intent),
      wake: (id) => this.wake(id),
      report: this.report,
    });
    this.meters = new ContextMeters(store, options.recovery?.contextWindow);
    this.delegationFacts = new DelegationFacts(this.repo, this.clock, (id) => this.wake(id));
    this.liveness = new ThreadLiveness({
      repo: this.repo,
      clock: this.clock,
      sessions: this.sessions,
      sends: this.sends,
      controls: this.controls,
      steering: this.steering,
      recovery: this.recovery,
      actor: (id) => this.actors.get(id),
      updateChild: (parent, child) => this.updateChild(parent, child),
    });
    this.settledTrees = new SettledTrees({
      repo: this.repo,
      clock: this.clock,
      sessions: this.sessions,
      recovery: this.recovery,
      actor: (id) => this.actors.get(id),
      drain: async (id) => {
        await Promise.all([this.sends.drain(id), this.controls.drain(id), this.steering.drain(id)]);
      },
      forget: (id) => this.forgetPurged(id),
      tree: (id) => this.liveness.tree(id),
    });
    // Settling or archiving releases a done thread's warm provider without the idle wait.
    const stopReleases = store.subscribe((events) => {
      for (const event of events) {
        const request = releaseRequest(event.payload);
        if (request) this.requestRelease(event.threadId, request);
        // Settling ends a turn a Stop or restart left on hold (startup does it for the rest).
        if (
          request === "release" &&
          this.readyState &&
          !this.closing &&
          this.repo.state(event.threadId)
        )
          store.atomic(() => this.recovery.closeSettled(event.threadId));
        // Settling ends everything the thread runs: its children, sessions and background tasks.
        if (
          event.payload.type === "thread.client.updated" &&
          typeof event.payload.changes.settledAt === "number"
        )
          this.stopSettled(event.threadId);
      }
    });
    // Live output the store had to drop stops only that thread's session, visibly.
    const stopQuarantine = store.onLiveWriteQuarantine((id, error) =>
      this.actors.get(id)?.quarantine(error),
    );
    this.stopReleaseWatch = () => {
      stopReleases();
      stopQuarantine();
    };
    this.repo.observe = (state, facts, events, at) => {
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
      this.nextThreadId,
      this.recovery,
      this.limits,
      this.admissions,
      workspaceDirectory,
      options.selectInstance,
      options.machine,
      options.providerEnabled,
      models,
    );
    this.internalHandler = {
      handle: (command, context) =>
        this.closing
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
    this.handler = {
      handle: (command, context) => this.internalHandler.handle(personCommand(command), context),
    };
    // A thread whose stored state cannot be read is left out of startup, never the daemon.
    const unreadable = (id: ThreadId, error: unknown) =>
      this.report(
        new Error(`Thread ${id} was skipped at startup: its stored state could not be read`, {
          cause: error,
        }),
      );
    const recover = () =>
      recoverEngine(
        this.repo,
        this.recovery,
        this.clock,
        (intent, message) => this.delivery.fail(intent, message),
        (id) => this.wake(id),
        unreadable,
        (id) => continuesNatively(this.repo, this.registry, id),
      );
    const recovery = this.recovery;
    const repo = this.repo;
    if (options.recovery?.preferences || options.models) {
      this.readyPromise = (async () => {
        await recovery.prepare();
        for (const state of repo.recoveryStates(unreadable)) await recovery.prepare(state.threadId);
        models.migrateCachedDefaults();
        if (!this.closing) recover();
        this.readyState = true;
        for (const id of this.pendingSettles) this.stopSettled(id);
        this.pendingSettles.clear();
      })();
    } else {
      recover();
      this.readyState = true;
      this.readyPromise = Promise.resolve();
    }
  }
  private stopSettled(id: ThreadId): void {
    if (this.closing) return;
    if (!this.readyState) this.pendingSettles.add(id);
    else if (this.repo.state(id)) void this.settledTrees.stop(id, this.settleFailed);
  }
  /** The liveness sweep's retry for a settled tree that still has a provider running. */
  async retrySettled(id: ThreadId): Promise<void> {
    if (!this.readyState || this.closing || this.repo.store.getThread(id)?.settledAt === undefined)
      return;
    if (this.liveness.tree(id).some((owner) => this.hasSession(owner)))
      await this.settledTrees.stop(id, this.settleFailed);
  }
  /** One trusted host policy for accepted commands, inside the receipt transaction. */
  bindCommandPolicy(policy: NonNullable<Engine["commandPolicy"]>): void {
    this.commandPolicy = policy;
  }
  private flushDepth = 0;
  /** A wake that outlived its thread's slot (it went dormant meanwhile) has nothing to run. */
  private async slotted(id: ThreadId, run: (actor: ThreadActor) => Promise<void>) {
    if (!this.actors.has(id) && !this.repo.reservedSlot(id)) return;
    await run(this.actor(id));
  }
  private actor(id: ThreadId): ThreadActor {
    let actor = this.actors.get(id);
    if (!actor) {
      // Sessions retiring to make room still hold an actor until their close completes.
      const room = this.limits.maxActiveThreads + this.repo.retiringCount;
      for (const [key, cached] of this.actors) {
        if (this.actors.size < room) break;
        if (!this.repo.reservedSlot(key)) {
          cached.stop();
          this.repo.evict(key);
          this.actors.delete(key);
        }
      }
      if (this.actors.size >= room) throw new Error("Engine actor capacity exceeded");
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
        (retired, generation) => this.delivery.expire(retired, generation),
      );
      actor.releaseRequested = releasedThread(this.repo.store.getThread(id));
      actor.generation = Math.max(
        this.repo.pending.latestGeneration(id),
        this.repo.interactions.latestGeneration(id),
      );
      this.actors.set(id, actor);
    }
    return actor;
  }
  providerAvailability(provider: ProviderKind) {
    if (!this.registry.has(provider)) return { installed: false, auth: "unknown" as const };
    const { installed, auth } = this.registry.get(provider).discovery;
    return { installed, auth };
  }
  capabilities(provider: ProviderKind, backend?: import("@ace/engine-api").ProviderBackend) {
    return structuredClone(this.registry.get(provider, backend).capabilities);
  }
  /**
   * Whether this thread's provider can steer mid-turn. Delegated child results
   * use it to decide steer (inject now) versus queue (wait for the turn end).
   * Providers differ: codex/claude/cursor/opencode/pi steer, acp never does,
   * and old CLIs without support report steer false.
   */
  supportsSteering(id: ThreadId): boolean {
    const thread = this.repo.store.getThread(id);
    if (!thread) return false;
    const provider = thread.provider;
    if (!this.registry.has(provider)) return false;
    const effective =
      thread.effectiveCapabilities ??
      thread.capabilities ??
      this.registry.get(provider).capabilities;
    if (!effective.steer) return false;
    // Backend-specific capability (e.g. cursor-sdk vs acp) wins when present.
    try {
      return (
        this.repo.store.getThread(id)?.effectiveCapabilities ??
        this.registry.get(provider, this.repo.backend(id)).capabilities
      ).steer;
    } catch {
      return effective.steer;
    }
  }
  /**
   * Daemon-owned child results run before the person's queued messages. A
   * result completes work the parent already started; the person's follow-ups
   * were typed without seeing it, so they run after the parent incorporates it.
   * Position 0 keeps every subagent result ahead of person input (ordered by id
   * among themselves) without bumping the queue revision clients edit against.
   */
  prioritizeSubagentResult(id: ThreadId, commandId: import("@ace/protocol").CommandId): void {
    this.repo.store.atomic(() => {
      this.repo.store
        .statement("UPDATE intents SET position=0 WHERE thread_id=? AND command_id=?")
        .run(id, commandId);
    });
  }
  /** Trusted spawn boundary for delegation. Receipt identity is caller-owned. */
  spawn(
    command: Command,
    scope: { access?: AccessRequest; parentThreadId?: ThreadId } = {},
    prepared?: Pick<import("../commands.ts").CommandContext, "preparedWorkspace">,
  ): CommandResult {
    const p = command.payload;
    if (p.type !== "thread.create" && p.type !== "thread.prepare")
      throw new Error("Spawn requires thread.create or thread.prepare");
    const id = p.threadId ?? ThreadId.parse(this.nextThreadId());
    let access: AccessMode | undefined;
    const requested = scope.access ?? p.access;
    if (scope.parentThreadId) {
      try {
        const narrowed = this.repo.permissions.narrow(
          scope.parentThreadId,
          this.permissionTarget(p.provider, p),
          requested,
          this.offeredModes(p.provider, p),
        );
        const parsed = AccessMode.safeParse(narrowed);
        access = parsed.success ? parsed.data : undefined;
      } catch (error) {
        return {
          commandId: command.id,
          ok: false,
          error: error instanceof AccessError ? error.code : "permission_ceiling_unverifiable",
        };
      }
    } else if (requested !== "inherit") access = requested;
    return this.repo.store.recordCommand(command.id, command.deviceId, () =>
      this.repo.store.atomic(() => {
        if (this.repo.store.getThread(id))
          return { commandId: command.id, ok: false, error: "thread_exists" };
        if (scope.parentThreadId && !this.repo.state(scope.parentThreadId))
          return { commandId: command.id, ok: false, error: "permission_parent_not_found" };
        const { access: _requested, ...rest } = p;
        const payload = { ...rest, threadId: id, ...(access ? { access } : {}) };
        const result = this.internalHandler.handle(CommandSchema.parse({ ...command, payload }), {
          ...commandContext(this.repo.store),
          ...prepared,
        });
        if (result.ok && scope.parentThreadId)
          this.repo.permissions.parent(id, scope.parentThreadId, this.clock.now());
        return result;
      }),
    );
  }
  /** A thread's access as its children see it: an ace mode, or null when unranked. */
  access(id: ThreadId): AccessMode | null {
    const parsed = AccessMode.safeParse(this.repo.permissions.effective(id));
    return parsed.success ? parsed.data : null;
  }
  private permissionTarget(
    provider: ProviderKind,
    selection?: Partial<import("@ace/protocol").AgentSelection>,
  ) {
    return importPermissionPolicyIdentity.parse({
      provider,
      backend: this.registry.get(provider).adapter.backend,
      ...(provider === "acp"
        ? importAcpIdentity.parse(selection)
        : { instanceId: this.targetInstance(provider, selection) }),
    });
  }
  private targetInstance(
    provider: ProviderKind,
    selection?: Partial<import("@ace/protocol").AgentSelection>,
  ) {
    return (
      selection?.accountId ??
      selection?.instanceId ??
      this.selectInstance?.(provider, this.registry.get(provider).adapter.backend) ??
      `${provider}-cli-default`
    );
  }
  /** The access a delegated child takes; throws AccessError when refused. */
  childAccess(
    parent: ThreadId,
    provider: ProviderKind,
    requested?: AccessRequest,
    selection?: Partial<import("@ace/protocol").AgentSelection>,
  ) {
    return this.repo.permissions.narrow(
      parent,
      this.permissionTarget(provider, selection),
      requested,
      this.offeredModes(provider, selection),
    );
  }
  /** The access modes a provider's target instance genuinely supports. */
  offeredModes(
    provider: ProviderKind,
    selection?: Partial<import("@ace/protocol").AgentSelection>,
  ): AccessModeOffer[] {
    if (!this.registry.has(provider)) return [];
    const base = this.registry.get(provider).capabilities;
    const instance =
      provider === "acp" ? selection?.instanceId : this.targetInstance(provider, selection);
    return reportedOrTable(
      provider,
      this.models.permissionCapabilities(provider, instance, base).accessModes,
    );
  }
  /** The parent's ceiling and the child modes it accepts, to explain a refused child policy. */
  childPermissionRefusal(
    parent: ThreadId,
    provider: ProviderKind,
    selection?: Partial<import("@ace/protocol").AgentSelection>,
  ) {
    return this.repo.permissions.refusal(
      parent,
      this.permissionTarget(provider, selection),
      this.offeredModes(provider, selection),
      selection?.access,
    );
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
  machineChild(...args: Parameters<DelegationFacts["machineChild"]>): void {
    this.delegationFacts.machineChild(...args);
  }
  delegationStarted(...args: Parameters<DelegationFacts["delegationStarted"]>): void {
    this.delegationFacts.delegationStarted(...args);
  }
  delegationSettled(...args: Parameters<DelegationFacts["delegationSettled"]>): void {
    this.delegationFacts.delegationSettled(...args);
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
  /** Live provider processes per thread, for `ace status`; bounded by live actors. */
  providerProcesses(): ProviderProcess[] {
    const processes: ProviderProcess[] = [];
    for (const actor of this.actors.values()) {
      const state = providerProcessState({
        session: Boolean(actor.session),
        closing: this.sessions.isClosing(actor.id),
        idleSince: actor.idleSince,
        idleDue: actor.idleDue,
      });
      const provider = this.repo.state(actor.id)?.config.provider;
      if (!state || !provider) continue;
      const releaseAt = actor.releaseAt();
      processes.push({
        threadId: actor.id,
        provider,
        state,
        ...(actor.idleSince === undefined ? {} : { idleSince: actor.idleSince }),
        ...(state === "idle-warm" && releaseAt !== undefined ? { releaseAt } : {}),
      });
    }
    return processes;
  }
  private requestRelease(id: ThreadId, request: "release" | "withdraw"): void {
    const actor = this.actors.get(id);
    if (!actor || this.closing) return;
    actor.releaseRequested = request === "release";
    // A done tree gets a due deadline now; live work keeps none until it settles.
    actor.schedule();
  }
  bindHostInteractions(
    handler: (command: Command) => import("@ace/protocol").CommandResult | undefined,
  ): void {
    const previous = this.hostInteractionHandler;
    this.hostInteractionHandler = (command) => handler(command) ?? previous?.(command);
  }
  /** Routes a stop of a background hold whose key starts with `prefix` to its external owner. */
  bindExternalTaskStop(prefix: string, stop: (id: string) => void): void {
    this.bindHostInteractions((command) => {
      if (command.payload.type !== "background_task.stop") return;
      const owner = this.repo.entityThread("backgroundTasks", command.payload.taskId);
      if (!owner) return;
      const key = this.repo.nativeEntity(owner, "tasks", command.payload.taskId);
      if (!key?.startsWith(prefix)) return;
      const task = this.repo.state(owner)?.tasks[key];
      if (task?.status !== "running")
        return { commandId: command.id, ok: false, error: "task_not_stoppable" };
      stop(key.slice(prefix.length));
      return { commandId: command.id, ok: true };
    });
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
    const agent = state.rootKey ?? "root";
    // A host approval (one mirrored from another machine) raised while one of ace's own tools
    // runs reads on that tool's row.
    const item =
      request.kind === "approval" ? liveAceCall(state, agent, request.target?.tool) : undefined;
    this.actor(threadId).apply([
      {
        type: "interaction.opened",
        agent,
        interaction: key,
        blocking: true,
        request,
        raw,
        ...(item ? { item } : {}),
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
    // A host gate (private browser, an ace ask question) may be the last hold on the
    // queue. Provider frames wake the thread on their own; a host-side close must too.
    this.wake(threadId);
  }
  closeHostGate(threadId: ThreadId, key: string, state: "resolved" | "cancelled"): void {
    this.resolveHostApproval(threadId, key, { state });
  }
  /** Permanent subtree cancellation discards resumable work. */
  discardRecovery(id: ThreadId): void {
    this.recovery.discard(id);
  }
  /** Tree cancellation from a Stop: resumable work goes, the Stop's held queue stays. */
  cancelRecovery(id: ThreadId): void {
    this.recovery.discardKeepingStop(id);
  }
  cancelDelegatedInputs(id: ThreadId): void {
    cancelDelegatedInputs(this.repo, id, this.clock.now());
  }
  captureContinuation(id: ThreadId): void {
    this.recovery.capture(id);
  }
  async changeWorkspace(
    id: ThreadId,
    commandId: string,
    effect: () => Promise<import("@ace/protocol").ThreadDetails>,
    reservation: WorkspaceChangeReservation = {
      roots: [this.repo.session(id).cwd],
      hasOwnedWork: () => false,
    },
    commit: () => void = () => {},
  ): Promise<void> {
    if (this.closing || this.workspaceChanges.has(id))
      throw new Error("workspace_change_in_progress");
    const change = changeEngineWorkspace(
      this.repo,
      id,
      commandId,
      () => this.clock.now(),
      async (owner) => {
        // Only a loaded actor can hold a provider session; loading one for every quiet thread
        // in a large project would only spend the engine's actor capacity.
        const actor = owner === id ? this.actor(owner) : this.actors.get(owner);
        if (!actor) return;
        await actor.flush();
        await this.sessions.close(actor, "idle");
        await actor.flush();
      },
      effect,
      (owner) => this.wake(owner),
      reservation,
      commit,
    ).finally(() => this.workspaceChanges.delete(id));
    this.workspaceChanges.set(id, change);
    return change;
  }
  /** Settles what dead providers left in the tree; genuinely live work is untouched. */
  async reconcileThread(id: ThreadId): Promise<void> {
    await this.readyPromise;
    await this.liveness.reconcileTree(id);
  }
  /** One thread, for periodic sweeps: a live session returns without reading state. */
  async reconcileOwn(id: ThreadId): Promise<void> {
    await this.readyPromise;
    await this.liveness.reconcile(id);
  }
  /** Even an idle provider may start autonomous work; retention cannot dispose its files. */
  hasSession(id: ThreadId): boolean {
    return (
      Boolean(this.actors.get(id)?.session) ||
      this.repo.sessionOpening(id) ||
      this.sessions.isClosing(id)
    );
  }
  cleanupThreads(id: ThreadId): ThreadId[] {
    return this.liveness.tree(id);
  }
  liveWork(id: ThreadId): LiveWork {
    return this.liveness.live(id);
  }
  /** Called after the durable cleanup fence has denied all new execution. */
  stopForDeletion(id: ThreadId): Promise<void> {
    return this.liveness.stop(id);
  }
  /**
   * Storage purged this stopped thread's engine records. Drop the cached actor that still
   * refers to them, so shutdown recovery and later wakes never read missing state.
   */
  forgetPurged(id: ThreadId): void {
    const actor = this.actors.get(id);
    if (actor) {
      actor.stop();
      this.actors.delete(id);
    }
    this.repo.evict(id);
    if (this.repo.reservedSlot(id)) {
      this.repo.release(id);
      this.wakeQueued();
    }
  }
  hasUnfinishedWork(id: ThreadId): boolean {
    return this.liveness.unfinished(id);
  }
  /** Close a retained session without cancelling its already settled work. */
  cleanupSession(id: ThreadId): Promise<void> {
    return this.liveness.stop(id);
  }
  /** Host cancellation retires one thread and records why it ended. */
  stopForCancellation(id: ThreadId): Promise<void> {
    return this.liveness.stopCancelled(id);
  }
  private deletionPolicy?: (id: ThreadId, commandId: string) => void;
  bindDeletionPolicy(policy: (id: ThreadId, commandId: string) => void): void {
    this.deletionPolicy = policy;
  }
  prepareDeletion(id: ThreadId, commandId: string): void {
    this.deletionPolicy?.(id, commandId);
  }
  async continueImported(
    request: Extract<import("@ace/protocol").ClientMessage, { type: "history.continue" }>,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol").ServerMessage> {
    await this.ready();
    signal.throwIfAborted();
    const thread = this.repo.store.getThread(request.threadId);
    if (!thread?.imported) throw new Error("Imported thread unavailable");
    const entry = this.registry.has(thread.provider)
      ? this.registry.get(thread.provider)
      : undefined;
    if (!entry?.capabilities.resume || request.mode !== "resume")
      return {
        type: "history.continue",
        status: "unsupported",
        reason: "Import this session to read it. This provider cannot continue it in ace.",
      };
    await this.repo.store.writable();
    adoptImportedThread(this.repo, thread.id, this.clock.now());
    if (!this.repo.reserve(thread.id)) throw new Error("Too many active threads");
    const actor = this.actor(thread.id);
    try {
      await this.sessions.open(actor);
      signal.throwIfAborted();
      await actor.flush();
      if (!actor.session) throw new Error("Provider stopped while opening the session");
      if (request.input.length) {
        const command = CommandSchema.parse({
          id: this.repo.nextCommandId(),
          deviceId: "ace-history",
          threadId: thread.id,
          payload: {
            type: "thread.send",
            threadId: thread.id,
            input: request.input,
            delivery: request.delivery,
          },
        });
        const result = this.handler.handle(command, commandContext(this.repo.store));
        if (!result.ok) throw new Error(result.error ?? "Message could not be sent");
        await this.flush();
      }
      return {
        type: "history.continue",
        status: "continued",
        threadId: thread.id,
        instanceId: thread.imported.instanceId,
        nativeSessionId:
          actor.session?.nativeSessionId ??
          this.repo.session(thread.id).nativeSessionId ??
          thread.imported.native.nativeId ??
          "",
      };
    } catch (error) {
      if (!actor.session) this.repo.release(thread.id);
      throw error;
    }
  }
  sessionMetadata(id: ThreadId) {
    return this.repo.session(id);
  }
  /** Why an admitted command failed when the engine delivered it, if it did. */
  commandFailure(commandId: import("@ace/protocol").CommandId): string | undefined {
    return this.repo.pending.failure(commandId);
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
  creationPending(id: ThreadId): boolean {
    return this.admissions.pending(id);
  }
  admitCreation(command: Command): CreationAdmission | string {
    command = personCommand(command);
    if (this.closing) return "daemon_shutting_down";
    if (!this.readyState) return "engine_starting";
    const validation = validateCreation(
      command,
      this.repo,
      this.registry,
      this.limits,
      workspaceDirectory,
      this.selectInstance,
      this.models,
    );
    if (!validation.ok) return validation.error;
    return this.admissions.acquire(command);
  }
  async prepareCommand(command: Command): Promise<void> {
    const p = command.payload;
    const provider =
      "provider" in p
        ? p.provider
        : "threadId" in p && p.threadId
          ? this.repo.store.getThread(ThreadId.parse(p.threadId))?.provider
          : undefined;
    if (provider) await this.waitForProvider?.(provider);
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
  /** What became of input `commandId` in thread `id`, and the run that took it (`InputFate`). */
  inputFate(id: ThreadId, commandId: import("@ace/protocol").CommandId): InputFate {
    const key = `input:${commandId}`;
    return this.repo.store.atomic(() =>
      inputFate({
        replacement: this.repo.inputs.replacement(id, commandId),
        written: this.repo.store.itemCreatedSeq(id, key) !== undefined,
        runId: this.repo.inputs.runOf(id, key),
        intent: this.repo.pending.delivery(id, commandId),
      }),
    );
  }
  queue(id: ThreadId): QueueSnapshot {
    return this.repo.queue.snapshot(id);
  }
  heldInterrupted(id: ThreadId): boolean {
    return heldInterrupted(this.repo, id, Boolean(this.actors.get(id)?.session));
  }
  /** A fresh reading says account `instanceId` has room: threads its limit held carry on. */
  accountRecovered(instanceId: string): void {
    if (this.closing || this.repo.store.isHistoryWriting()) return;
    this.repo.store.atomic(() => {
      for (const id of this.repo.queue.limited())
        if (this.repo.session(id).instanceId === instanceId) this.recovery.accountRecovered(id);
    });
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
    if (actor && !actor.poisoned && !actor.backlog().frames) {
      actor.stop();
      this.actors.delete(id);
      this.repo.evict(id);
    }
    if (this.repo.reservedSlot(id)) {
      this.repo.release(id);
      this.wakeQueued();
    }
  }
  private deferredWakes = new Set<ThreadId>();
  private wake(id: ThreadId): void {
    if (
      this.closing ||
      this.repo.cleaning(id) ||
      this.repo.store.getThread(id)?.deletedAt !== undefined ||
      this.repo.store.getThread(id)?.continuation
    )
      return;
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
    if (actor.poisoned || this.repo.cleaning(actor.id)) return;
    if (actor.idleDue && actor.session) await this.sessions.close(actor, "idle");
    const pendingControls = this.repo.pending.controls(actor.id);
    const controls =
      !actor.session &&
      (this.repo.pending.message(actor.id) || this.repo.pending.recovery(actor.id))
        ? pendingControls.filter((intent) => intent.kind === "thread.interrupt")
        : pendingControls;
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
    if (this.repo.cleaning(actor.id)) return;
    if (actor.poisoned) {
      if (actor.session) await this.sessions.close(actor, "user");
      for (const intent of this.repo.pending.headers(actor.id))
        if (["pending", "queued"].includes(intent.status))
          this.delivery.fail(
            intent,
            actor.persistenceFailed
              ? "Thread stopped after a persistence failure; restart the daemon before retrying"
              : "Provider stopped after an invalid response; resume the thread to retry",
          );
      this.syncQueue(actor);
      if (!actor.persistenceFailed) {
        actor.stop();
        this.actors.delete(actor.id);
        this.repo.evict(actor.id);
        this.repo.release(actor.id);
        this.wakeQueued();
      }
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
    // Every queue change wakes the thread; keep core's view of a held queue current with it.
    this.syncQueue(actor);
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
        : // A steer joins the running turn on its own lane; with no turn running it goes first.
          first && this.isSteer(first) && rootRun(this.repo.requireState(actor.id))
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
          : ["new", "done", "failed"].includes(status.state) ||
            this.repo.quiescent(state) ||
            // A plain message only needs the provider between turns. One that changes the
            // model or options may reopen the session, which would end its background
            // commands, so it still waits for the whole tree.
            (intent.kind === "thread.send" &&
              (intent.trigger === undefined || intent.trigger === "user") &&
              !this.repo.pending.hasSelection(intent.id) &&
              this.repo.acceptsPersonInput(state));
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
    return this.steerLane.isSteer(intent);
  }
  private async steer(actor: ThreadActor): Promise<void> {
    await actor.flush();
    if (actor.poisoned || this.closing || this.repo.cleaning(actor.id) || !actor.session) return;
    const queue = this.repo.queue.get(actor.id);
    if (queue.paused || queue.limited) return;
    await this.steerLane.run(actor);
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
        await this.settledTrees.settled();
        await Promise.all([...this.actors.values()].map((actor) => actor.flush()));
        await Promise.all([this.sends.flush(), this.controls.flush(), this.steering.flush()]);
        await Promise.all([...this.actors.values()].map((actor) => actor.flush()));
        await this.recovery.flush();
      } while (
        this.sends.active ||
        this.controls.active ||
        this.steering.active ||
        this.settledTrees.active
      );
    } finally {
      this.flushDepth--;
    }
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
      this.stopReleaseWatch();
      await this.settledTrees.settled();
      this.flushDepth++;
      await Promise.allSettled(this.workspaceChanges.values());
      await this.readyPromise;
      this.recovery.close();
      for (const actor of this.actors.values()) {
        await actor.flush();
        this.recovery.captureRestart(actor.id);
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
