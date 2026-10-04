import { PermissionMode, NativeSessionId } from "@ace/protocol";
import { supportsPermissionMode } from "@ace/core";
import { AcpIdentity } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import type { ThreadActor, EngineClock } from "./actor.ts";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import { z } from "zod";

const TurnPermissionSession = z.object({ permissionModePerTurn: z.literal(true) });
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
  repo: EngineRepository;
  permissionSettings?: import("./permissions.ts").PermissionSettings;
  prepareWorkspace?(id: ThreadId): Promise<string>;
  registry: AdapterRegistry;
  clock: EngineClock;
  closing(): boolean;
  wake(id: ThreadId): void;
  expireDelivery(actor: ThreadActor): void;
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
  isClosing(id: ThreadId): boolean {
    return this.closing.has(id);
  }
  constructor(dependencies: SessionDependencies) {
    this.dependencies = dependencies;
  }
  async open(actor: ThreadActor): Promise<void> {
    await this.dependencies.repo.store.writable();
    const stateBefore = this.dependencies.repo.requireState(actor.id);
    if (actor.session && TurnPermissionSession.safeParse(actor.session).success) return;
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
    try {
      const state = this.dependencies.repo.requireState(actor.id);
      let metadata = this.dependencies.repo.session(actor.id);
      const backend = this.dependencies.repo.backend(actor.id);
      const { adapter, capabilities } = this.dependencies.registry.get(
        state.config.provider,
        backend,
      );
      const entity = this.dependencies.repo.store.getThread(actor.id);
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
      await this.dependencies.repo.store.writable();
      this.dependencies.repo.store.workspaceReservations.assertAvailable(metadata.cwd);
      const session = await adapter.openSession({
        ...context,
        outputFlow: actor.outputFlow,
        permissionMode: mode,
        ...{
          getPermissionMode: async () => {
            const next = await this.dependencies.repo.permissions.resolve(
              actor.id,
              this.dependencies.permissionSettings,
            );
            if (generation !== actor.generation || lifetime.signal.aborted)
              throw new Error("Codex turn policy requested after session closed");
            if (
              !supportsPermissionMode(
                (actor.effectiveCapabilities ?? capabilities).permissions,
                next,
              )
            )
              throw new Error("permission_mode_unsupported");
            return next;
          },
          interactionId: (key: string) =>
            this.dependencies.repo.requireState(actor.id).interactions[key]?.id,
        },
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
        ...(metadata.model === undefined ? {} : { model: metadata.model }),
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
        onFrame: (frame) => {
          if (state.config.provider === "codex" && frame.dir === "note") {
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
          });
          // Void consumers rely on the actor's failure facts; ACK consumers still
          // receive the rejecting promise and must stop intake on failed commit.
          void committed.catch(() => {});
          return committed;
        },
        onExit: (exit) =>
          actor.enqueue(() => {
            if (generation !== actor.generation) return;
            actor.session = undefined;
            lifetime.abort();
            actor.generation++;
            this.dependencies.expireDelivery(actor);
            actor.apply([
              { type: "process.exited", ...exit },
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
      if (state.config.provider === "codex" && !TurnPermissionSession.safeParse(session).success)
        this.dependencies.repo.permissions.applied(actor.id, mode, this.dependencies.clock.now());
      actor.effectiveCapabilities = session.effectiveCapabilities ?? capabilities;
      this.dependencies.repo.store.atomic(() => {
        this.dependencies.repo.nativeSession(
          actor.id,
          session.nativeSessionId,
          session.backend ??
            adapter.backend ??
            (state.config.provider === "cursor" ? "acp" : undefined),
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
    } catch (error) {
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
      throw error;
    } finally {
      this.dependencies.repo.finishSessionOpen(actor.id);
    }
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
      if (!actor.session && !actor.poisoned) this.dependencies.released(actor.id);
    }
  }
}
