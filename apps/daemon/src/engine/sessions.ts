import { AcpIdentity } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import type { ThreadActor, EngineClock } from "./actor.ts";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";

interface SessionDependencies {
  repo: EngineRepository;
  prepareWorkspace?(id: ThreadId): Promise<string>;
  registry: AdapterRegistry;
  clock: EngineClock;
  closing(): boolean;
  wake(id: ThreadId): void;
  expireDelivery(actor: ThreadActor): void;
  released(id: ThreadId): void;
  context?(
    threadId: ThreadId,
    signal: AbortSignal,
  ): Promise<Partial<Pick<SessionContext, "env" | "mcp" | "onSessionMetadata" | "acpLaunch">>>;
}
export class Sessions {
  private dependencies: SessionDependencies;
  constructor(dependencies: SessionDependencies) {
    this.dependencies = dependencies;
  }
  async open(actor: ThreadActor): Promise<void> {
    if (actor.session) return;
    const lifetime = new AbortController();
    actor.lifetime = lifetime;
    const generation = ++actor.generation;
    try {
      const state = this.dependencies.repo.requireState(actor.id);
      const { adapter, capabilities } = this.dependencies.registry.get(state.config.provider);
      let metadata = this.dependencies.repo.session(actor.id);
      const entity = this.dependencies.repo.store.getThread(actor.id);
      if (entity?.deletedAt !== undefined) throw new Error("Thread deleted");
      if (entity?.details?.mode === "worktree" && !metadata.nativeSessionId) {
        if (!this.dependencies.prepareWorkspace)
          throw new Error("Worktree preparation unavailable");
        const cwd = await this.dependencies.prepareWorkspace(actor.id);
        this.dependencies.repo.store.atomic((db) =>
          db.prepare("UPDATE engine_sessions SET cwd=? WHERE thread_id=?").run(cwd, actor.id),
        );
        metadata = this.dependencies.repo.session(actor.id);
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
      actor.apply([{ type: "process.started" }]);
      const context = await this.dependencies.context?.(actor.id, lifetime.signal);
      const session = await adapter.openSession({
        ...context,
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
        ...(transition.selection ? { options: transition.selection.options } : {}),
        ...(transition.fork && metadata.nativeSessionId === undefined
          ? { fork: transition.fork }
          : {}),
        ...(metadata.instanceId ? { instanceId: metadata.instanceId } : {}),
        ...(metadata.model === undefined ? {} : { model: metadata.model }),
        ...(metadata.nativeSessionId === undefined
          ? {}
          : { resume: { nativeSessionId: metadata.nativeSessionId } }),
        signal: lifetime.signal,
        onFrame: (frame) => actor.frame(frame, generation),
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
      if (generation !== actor.generation || actor.poisoned || this.dependencies.closing()) {
        await session.close("shutdown");
        throw new Error("Provider session closed while opening");
      }
      actor.session = session;
      actor.effectiveCapabilities = session.effectiveCapabilities ?? capabilities;
      this.dependencies.repo.store.atomic(() => {
        this.dependencies.repo.nativeSession(actor.id, session.nativeSessionId, session.instanceId);
        delete transition.fork;
        if (transition.selection && session.instanceId)
          transition.selection.instanceId = session.instanceId;
        this.dependencies.repo.transitions.set(actor.id, transition);
        if (transition.selection)
          this.dependencies.repo.store.appendEvents(
            actor.id,
            [{ type: "thread.updated", execution: transition.selection }],
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
    }
  }

  async close(actor: ThreadActor, reason: "idle" | "user" | "shutdown"): Promise<void> {
    const session = actor.session;
    if (!session) return;
    const lifetime = actor.lifetime;
    actor.session = undefined;
    const generation = actor.generation;
    await actor.flush();
    try {
      await session.close(reason);
    } catch (error) {
      await actor.flush();
      // No exit acknowledgement means the old process still owns its session.
      if (actor.generation === generation) actor.session = session;
      actor.idleDue = false;
      throw error;
    }
    await actor.flush();
    lifetime?.abort();
    const ownsGeneration = actor.generation === generation;
    if (ownsGeneration) {
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
    }
    actor.schedule();
    if (ownsGeneration && !actor.session && !actor.poisoned) this.dependencies.released(actor.id);
  }
}
