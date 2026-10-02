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
}
export class Sessions {
  private dependencies: SessionDependencies;
  constructor(dependencies: SessionDependencies) {
    this.dependencies = dependencies;
  }
  async open(actor: ThreadActor): Promise<void> {
    if (actor.session) return;
    const state = this.dependencies.repo.requireState(actor.id);
    const { adapter, capabilities } = this.dependencies.registry.get(state.config.provider);
    const metadata = this.dependencies.repo.session(actor.id);
    if (metadata.nativeSessionId && !capabilities.resume)
      throw new Error("Provider cannot resume this thread");
    actor.translator = adapter.createTranslator({ threadId: actor.id, rootKey: "root" });
    actor.lifetime = new AbortController();
    const generation = ++actor.generation;
    actor.apply([{ type: "process.started" }]);
    const session = await adapter.openSession({
      threadId: actor.id,
      cwd: metadata.cwd,
      ...(metadata.model === undefined ? {} : { model: metadata.model }),
      ...(metadata.nativeSessionId === undefined
        ? {}
        : { resume: { nativeSessionId: metadata.nativeSessionId } }),
      signal: actor.lifetime.signal,
      onFrame: (frame) => actor.frame(frame, generation),
      onExit: (exit) =>
        actor.enqueue(() => {
          if (generation !== actor.generation) return;
          actor.session = undefined;
          actor.lifetime?.abort();
          actor.generation++;
          this.dependencies.expireDelivery(actor);
          actor.apply([{ type: "process.exited", ...exit }]);
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
    this.dependencies.repo.nativeSession(actor.id, session.nativeSessionId);
    this.dependencies.wake(actor.id);
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
      if (actor.generation === generation) {
        actor.generation++;
        this.dependencies.expireDelivery(actor);
        actor.idleDue = false;
        this.dependencies.repo.apply(
          actor.id,
          [{ type: "process.exited", deliberate: !actor.poisoned }],
          this.dependencies.clock.now(),
        );
      }
      actor.schedule();
      if (!actor.session && !actor.poisoned) this.dependencies.released(actor.id);
    }
  }
}
