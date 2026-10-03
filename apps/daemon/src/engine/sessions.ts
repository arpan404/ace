import { AcpIdentity } from "@ace/protocol";
import type { SessionContext } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import type { ThreadActor, EngineClock } from "./actor.ts";
import type { EngineRepository } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";

interface SessionDependencies {
  repo: EngineRepository;
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
    this.dependencies.repo.beginSessionOpen(actor.id);
    const lifetime = new AbortController();
    actor.lifetime = lifetime;
    const generation = ++actor.generation;
    try {
      const state = this.dependencies.repo.requireState(actor.id);
      const { adapter, capabilities } = this.dependencies.registry.get(state.config.provider);
      const metadata = this.dependencies.repo.session(actor.id);
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
      this.dependencies.repo.nativeSession(actor.id, session.nativeSessionId, session.instanceId);
      this.dependencies.wake(actor.id);
    } catch (error) {
      await actor.flush();
      if (generation === actor.generation) {
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
    actor.session = undefined;
    const generation = actor.generation;
    try {
      await actor.flush();
      await session.close(reason);
    } finally {
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
      if (ownsGeneration) actor.releaseInputs();
      actor.schedule();
      if (ownsGeneration && !actor.session && !actor.poisoned) this.dependencies.released(actor.id);
    }
  }
}
