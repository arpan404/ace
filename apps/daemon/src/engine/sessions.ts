import { unexpectedStopNotice } from "./thread-liveness.ts";
import { lostWork } from "./lost-work.ts";
import { providerCommandMetadata, type ProviderCommandEvent } from "./provider-command-metadata.ts";
import { isDefaultSelection } from "@ace/models";
import type { EngineModels } from "./models.ts";
import { SessionOpenError } from "@ace/provider-kit/open-error";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
import { PermissionMode, NativeSessionId } from "@ace/protocol";
import { supportsPermissionMode } from "@ace/core";
import { AcpIdentity } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import type { ThreadActor, EngineClock } from "./actor.ts";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import { z } from "zod";

const TurnPermissionSupport = z.object({ event: z.literal("permission-turn-policy-supported") });
const AppliedPermission = z.object({
  event: z.literal("permission-mode-applied"),
  mode: PermissionMode,
});

const SessionIdentity = z.strictObject({
  backend: z.enum(["acp", "cursor-sdk"]),
  instanceId: z.string().min(1).max(256),
  nativeSessionId: NativeSessionId.optional(),
});

interface SessionDependencies {
  commandEvent?(event: ProviderCommandEvent): void;
  models: EngineModels;
  repo: EngineRepository;
  permissionSettings?: import("./permissions.ts").PermissionSettings;
  prepareWorkspace?(id: ThreadId): Promise<string>;
  assertWorkspaceAvailable?(cwd: string): Promise<void>;
  registry: AdapterRegistry;
  clock: EngineClock;
  closing(): boolean;
  wake(id: ThreadId): void;
  expireDelivery(actor: ThreadActor): void;
  openFailed?(
    id: ThreadId,
    details: import("@ace/protocol").ProviderErrorDetails,
    route?: import("./session-open-route.ts").SessionOpenRoute,
  ): void;
  released(id: ThreadId): void;
  mcp?(
    threadId: ThreadId,
    agentId: string,
    lifetime: AbortSignal,
  ): NonNullable<SessionContext["aceMcp"]>;
  context?(
    threadId: ThreadId,
    signal: AbortSignal,
  ): Promise<Partial<Pick<SessionContext, "env" | "mcp" | "onSessionMetadata" | "acpLaunch">>>;
}
export class Sessions {
  private dependencies: SessionDependencies;
  private closing = new Set<ThreadId>();
  private turnPermissions = new Map<ThreadId, number>();
  isClosing(id: ThreadId): boolean {
    return this.closing.has(id);
  }
  constructor(dependencies: SessionDependencies) {
    this.dependencies = dependencies;
  }
  async open(actor: ThreadActor): Promise<void> {
    if (this.dependencies.repo.store.getThread(actor.id)?.continuation)
      throw new Error("Cursor CLI threads are read-only; continue in a new thread");
    await this.dependencies.repo.store.writable();
    if (this.dependencies.repo.cleaning(actor.id)) throw new Error("Thread is being deleted");
    const stateBefore = this.dependencies.repo.requireState(actor.id);
    if (actor.session && this.turnPermissions.get(actor.id) === actor.generation) return;
    // A prepared root is starting before its first turn, not a pinned live policy.
    const ownLive = stateBefore.hasRun && !this.dependencies.repo.quiescent(stateBefore);
    if (actor.session && ownLive) return;
    const mode = ownLive
      ? this.dependencies.repo.permissions.effective(actor.id)
      : await this.dependencies.repo.permissions.resolve(
          actor.id,
          this.dependencies.permissionSettings,
        );
    await this.dependencies.repo.store.writable();
    const entry = this.dependencies.registry.get(
      stateBefore.config.provider,
      this.dependencies.repo.backend(actor.id),
    );
    if (!supportsPermissionMode(entry.capabilities.permissions, mode))
      throw new Error(
        `permission_mode_unsupported: ${stateBefore.config.provider} cannot honor ${mode}`,
      );
    if (actor.session && this.dependencies.repo.permissions.effective(actor.id) !== mode)
      await this.close(actor, "idle");
    if (actor.session) {
      this.dependencies.repo.permissions.applied(actor.id, mode, this.dependencies.clock.now());
      return;
    }
    if (stateBefore.config.provider !== "codex")
      this.dependencies.repo.permissions.applied(actor.id, mode, this.dependencies.clock.now());
    this.dependencies.repo.beginSessionOpen(actor.id);
    const lifetime = new AbortController();
    actor.lifetime = lifetime;
    const generation = ++actor.generation;
    let opening = true;
    let errorEnvironment: NodeJS.ProcessEnv | undefined;
    let errorSecrets: readonly string[] = [];
    let openingModel: string | undefined;
    let openingInstance: string | undefined;
    try {
      const state = this.dependencies.repo.requireState(actor.id);
      let metadata = this.dependencies.repo.session(actor.id);
      const backend = this.dependencies.repo.backend(actor.id);
      const { adapter, capabilities } = this.dependencies.registry.get(
        state.config.provider,
        backend,
      );
      const entity = this.dependencies.repo.store.getThread(actor.id);
      if (lifetime.signal.aborted || this.dependencies.repo.cleaning(actor.id))
        throw new Error("Thread is being deleted");
      if (entity?.deletedAt !== undefined) throw new Error("Thread deleted");
      if (!metadata.workspaceReady) {
        if (!this.dependencies.prepareWorkspace)
          throw new Error("Worktree preparation unavailable");
        const cwd = await this.dependencies.prepareWorkspace(actor.id);
        await this.dependencies.repo.store.writable();
        this.dependencies.repo.store.completeWorkspacePreparation(actor.id, metadata.cwd, cwd);
        metadata = this.dependencies.repo.session(actor.id);
        if (!metadata.workspaceReady || metadata.cwd !== cwd)
          throw new Error("Workspace root changed while preparing");
      }
      const previousSelection = this.dependencies.repo.transitions.get(actor.id).selection ?? {
        provider: state.config.provider,
        options: {},
        ...metadata,
      };
      openingModel = previousSelection.model;
      openingInstance = previousSelection.instanceId ?? metadata.instanceId;
      const resolvedSelection = await this.dependencies.models.prepare(
        previousSelection,
        this.dependencies.models.identity(actor.id),
      );
      openingModel = resolvedSelection.model;
      openingInstance = resolvedSelection.instanceId;
      if (resolvedSelection.model && resolvedSelection.model !== metadata.model)
        this.dependencies.models.remember(actor.id, resolvedSelection);
      metadata = this.dependencies.repo.session(actor.id);
      const transition = this.dependencies.repo.transitions.get(actor.id);
      if (state.config.provider !== "acp" && metadata.nativeSessionId && !capabilities.resume)
        throw new Error("Provider cannot resume this thread");
      const rootKey = state.rootKey ?? "root";
      const thread = this.dependencies.repo.store.getThread(actor.id);
      const identity = thread?.provider === "acp" ? AcpIdentity.parse(thread) : undefined;
      actor.translator = adapter.createTranslator({
        threadId: actor.id,
        rootKey,
        ...(identity ? { acpIdentity: identity } : {}),
      });
      if (backend === "cursor-sdk")
        this.dependencies.repo.recovery.restore(actor.id, actor.translator);
      actor.apply([{ type: "process.started" }]);
      const rootAgent = state.agents[rootKey]?.agent;
      const aceMcp =
        rootAgent && state.config.provider !== "acp"
          ? this.dependencies.mcp?.(actor.id, rootAgent.id, lifetime.signal)
          : undefined;
      const context = await this.dependencies.context?.(actor.id, lifetime.signal);
      errorEnvironment = context?.env;
      errorSecrets = [...(context?.mcp?.secrets ?? []), ...(aceMcp ? [aceMcp.bearer] : [])];
      await this.dependencies.repo.store.writable();
      if (lifetime.signal.aborted || this.dependencies.repo.cleaning(actor.id))
        throw new Error("Thread is being deleted");
      await this.dependencies.assertWorkspaceAvailable?.(metadata.cwd);
      this.dependencies.repo.store.workspaceReservations.assertAvailable(metadata.cwd);
      const codexContext = {
        getPermissionMode: async () => {
          const next = await this.dependencies.repo.permissions.resolve(
            actor.id,
            this.dependencies.permissionSettings,
          );
          if (generation !== actor.generation || lifetime.signal.aborted)
            throw new Error("Codex turn policy requested after session closed");
          if (
            !supportsPermissionMode((actor.effectiveCapabilities ?? capabilities).permissions, next)
          )
            throw new Error("permission_mode_unsupported");
          return next;
        },
        interactionId: (key: string) =>
          this.dependencies.repo.requireState(actor.id).interactions[key]?.id,
      };
      const session = await adapter.openSession({
        ...context,
        outputFlow: actor.outputFlow,
        permissionMode: mode,
        ...codexContext,
        ...(aceMcp ? { aceMcp } : {}),
        options: transition.selection?.options ?? metadata.options ?? {},
        ...(identity ? { acpIdentity: identity } : {}),
        onCapabilities: (effectiveCapabilities, acpSupport) => {
          if (generation !== actor.generation) return;
          actor.effectiveCapabilities = effectiveCapabilities;
          actor.enqueue(() =>
            this.dependencies.repo.store.appendEvents(
              actor.id,
              [
                {
                  type: "thread.updated",
                  effectiveCapabilities,
                  ...(acpSupport ? { acpSupport } : {}),
                },
              ],
              this.dependencies.clock.now(),
            ),
          );
        },
        threadId: actor.id,
        rootKey,
        cwd: metadata.cwd,
        ...(transition.fork && metadata.nativeSessionId === undefined
          ? { fork: transition.fork }
          : {}),
        ...(metadata.instanceId ? { instanceId: metadata.instanceId } : {}),
        ...(metadata.model === undefined || isDefaultSelection(metadata.model)
          ? {}
          : { model: metadata.model }),
        ...(metadata.nativeSessionId === undefined
          ? {}
          : {
              resume: {
                nativeSessionId: metadata.nativeSessionId,
                ...(backend ? { backend } : {}),
                ...(backend === "cursor-sdk"
                  ? {
                      afterFrameOffset: this.dependencies.repo.recovery.offset(actor.id),
                    }
                  : {}),
                ...(metadata.instanceId ? { instanceId: metadata.instanceId } : {}),
              },
            }),
        signal: lifetime.signal,
        onSessionIdentity: (selection) => {
          if (generation !== actor.generation || lifetime.signal.aborted)
            throw new Error("Provider identity arrived after host admission was fenced");
          const parsed = SessionIdentity.parse(selection);
          if (parsed.backend !== backend) throw new Error("Provider changed its selected backend");
          this.dependencies.repo.pinSessionIdentity(actor.id, {
            backend: parsed.backend,
            instanceId: parsed.instanceId,
            ...(parsed.nativeSessionId ? { nativeSessionId: parsed.nativeSessionId } : {}),
          });
        },
        onInputMessage: (messageIdentity) => {
          if (generation !== actor.generation || lifetime.signal.aborted)
            throw new Error("Provider input identity arrived after host admission was fenced");
          this.dependencies.repo.inputs.identify(actor.id, messageIdentity);
        },
        onFrame: (frame) => {
          if (state.config.provider === "codex" && frame.dir === "note") {
            if (TurnPermissionSupport.safeParse(frame.data).success)
              actor.enqueue(() => {
                if (generation === actor.generation && !lifetime.signal.aborted)
                  this.turnPermissions.set(actor.id, generation);
              });
            const permission = AppliedPermission.safeParse(frame.data);
            if (permission.success)
              actor.enqueue(() => {
                if (generation !== actor.generation || lifetime.signal.aborted) return;
                this.dependencies.repo.permissions.applied(
                  actor.id,
                  permission.data.mode,
                  this.dependencies.clock.now(),
                );
              });
          }
          const accepted = actor.frame(frame, generation);
          const committed = accepted.then(() => {
            if (actor.poisoned) throw new Error("Provider frame failed to commit");
            if (generation === actor.generation && !lifetime.signal.aborted) {
              const data = providerCommandMetadata(frame);
              if (data !== undefined)
                this.dependencies.commandEvent?.({
                  type: "commands.runtime",
                  threadId: actor.id,
                  data,
                });
            }
          });
          // Void consumers rely on the actor's failure facts; ACK consumers still
          // receive the rejecting promise and must stop intake on failed commit.
          void committed.catch(() => {});
          return committed;
        },
        onExit: (exit) =>
          actor.enqueue(() => {
            if (generation !== actor.generation) return;
            this.dependencies.commandEvent?.({ type: "session.closed", threadId: actor.id });
            actor.session = undefined;
            this.turnPermissions.delete(actor.id);
            lifetime.abort();
            actor.generation++;
            // No input can have been consumed until open returns a usable session.
            if (!opening) this.dependencies.expireDelivery(actor);
            // Say so in the transcript only when the death cost work, not after an idle exit.
            const before = this.dependencies.repo.requireState(actor.id);
            const lost = !exit.deliberate && lostWork(before) !== undefined;
            actor.apply([
              { type: "process.exited", ...exit },
              ...(lost
                ? [unexpectedStopNotice(before.rootKey, this.dependencies.clock.now())]
                : []),
              { type: "queue.changed", source: "provider", count: 0 },
            ]);
            if (!actor.poisoned) this.dependencies.released(actor.id);
            this.dependencies.wake(actor.id);
          }),
      });
      await actor.flush();
      if (
        generation !== actor.generation ||
        actor.poisoned ||
        lifetime.signal.aborted ||
        this.dependencies.closing()
      ) {
        await session.close("shutdown");
        throw new Error("Provider session closed while opening");
      }
      actor.session = session;
      if (state.config.provider === "codex" && this.turnPermissions.get(actor.id) !== generation)
        this.dependencies.repo.permissions.applied(actor.id, mode, this.dependencies.clock.now());
      actor.effectiveCapabilities = session.effectiveCapabilities ?? capabilities;
      this.dependencies.repo.store.atomic(() => {
        this.dependencies.repo.nativeSession(
          actor.id,
          session.nativeSessionId,
          session.backend ?? adapter.backend,
          session.instanceId,
        );
        delete transition.fork;
        if (transition.selection && session.instanceId)
          transition.selection.instanceId = session.instanceId;
        this.dependencies.repo.transitions.set(actor.id, transition);
        this.dependencies.repo.store.appendEvents(
          actor.id,
          [
            {
              type: "thread.updated",
              capabilities,
              ...((session.backend ?? backend) ? { backend: session.backend ?? backend } : {}),
              ...(transition.selection ? { execution: transition.selection } : {}),
            },
          ],
          this.dependencies.clock.now(),
        );
      });
      this.dependencies.wake(actor.id);
      opening = false;
    } catch (error) {
      const failure = new SessionOpenError(
        `${stateBefore.config.provider} session opening failed`,
        error,
        { env: { ...process.env, ...errorEnvironment } },
        (value) =>
          typeof value === "string"
            ? errorSecrets.reduce(
                (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
                value,
              )
            : value,
      );
      try {
        const scrub = createDiagnosticRedactor({ env: { ...process.env, ...errorEnvironment } });
        const routeField = (value: string | undefined): string | null =>
          value === undefined
            ? null
            : scrub(
                errorSecrets.reduce(
                  (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
                  value,
                ),
              ).slice(0, 256);
        const model = routeField(openingModel);
        const instance = routeField(openingInstance);
        const backend = this.dependencies.repo.backend(actor.id);
        const diagnostic = this.dependencies.openFailed?.(
          actor.id,
          {
            provider: stateBefore.config.provider,
            code: failure.code,
            title: failure.title,
            detail: failure.detail,
          },
          {
            ...(model ? { model } : {}),
            ...(instance ? { instance } : {}),
            ...(backend ? { backend } : {}),
          },
        );
        void Promise.resolve(diagnostic).catch(() => {});
      } catch {
        // Diagnostics are optional; their failure cannot replace the sanitized
        // provider error or prevent lifetime/capacity cleanup below.
      }
      await actor.flush();
      if (generation === actor.generation) {
        const session = actor.session;
        actor.session = undefined;
        lifetime.abort();
        try {
          await session?.close("shutdown");
        } catch {
          /* Opening failure remains authoritative. */
        }
        actor.generation++;
        this.turnPermissions.delete(actor.id);
        actor.translator = undefined;
        actor.lifetime = undefined;
        lifetime.abort();
        try {
          actor.apply([
            { type: "process.exited", deliberate: false },
            { type: "queue.changed", source: "provider", count: 0 },
          ]);
        } finally {
          this.dependencies.released(actor.id);
        }
      }
      throw failure;
    } finally {
      this.dependencies.repo.finishSessionOpen(actor.id);
    }
  }

  confirmModel(actor: ThreadActor, model: string): void {
    const metadata = this.dependencies.repo.session(actor.id);
    this.dependencies.models.remember(actor.id, {
      provider: this.dependencies.repo.requireState(actor.id).config.provider,
      options: metadata.options ?? {},
      ...metadata,
      model,
    });
  }
  async selectModel(actor: ThreadActor, model: string): Promise<string> {
    const metadata = this.dependencies.repo.session(actor.id);
    const selection = await this.dependencies.models.prepare(
      {
        provider: this.dependencies.repo.requireState(actor.id).config.provider,
        options: metadata.options ?? {},
        ...metadata,
        model,
      },
      this.dependencies.models.identity(actor.id),
    );
    if (!selection.model)
      throw new Error("No available default model; refresh the provider catalog");
    return selection.model;
  }
  async close(actor: ThreadActor, reason: "idle" | "user" | "shutdown"): Promise<void> {
    const session = actor.session;
    if (!session) return;
    const lifetime = actor.lifetime;
    const generation = actor.generation;
    this.closing.add(actor.id);
    actor.session = undefined;
    this.dependencies.wake(actor.id);
    try {
      await actor.flush();
      try {
        await session.close(reason);
      } catch (error) {
        await actor.flush();
        // Without exit acknowledgement, the old process still owns the session.
        if (actor.generation === generation) actor.session = session;
        actor.idleDue = false;
        throw error;
      }
      await actor.flush();
      this.dependencies.commandEvent?.({ type: "session.closed", threadId: actor.id });
      lifetime?.abort();
      if (actor.generation === generation) {
        actor.generation++;
        this.dependencies.expireDelivery(actor);
        actor.idleDue = false;
        this.dependencies.repo.apply(
          actor.id,
          [
            { type: "process.exited", deliberate: !actor.poisoned },
            { type: "queue.changed", source: "provider", count: 0 },
          ],
          this.dependencies.clock.now(),
        );
        actor.releaseInputs();
      }
      actor.schedule();
    } finally {
      this.closing.delete(actor.id);
      if (!actor.session) this.turnPermissions.delete(actor.id);
      if (!actor.session && !actor.poisoned) this.dependencies.released(actor.id);
    }
  }
}
