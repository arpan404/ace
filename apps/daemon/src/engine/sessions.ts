import { AcpIdentity, type TurnOptions } from "@ace/protocol";
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
        ...(metadata.options ? { options: metadata.options } : {}),
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
      if (metadata.options && Object.keys(metadata.options).length > 0) {
        if (!session.configure) {
          await session.close("shutdown");
          actor.session = undefined;
          throw new Error("Provider options configuration unavailable");
        }
        await session.configure({
          provider: state.config.provider,
          ...(metadata.model ? { model: metadata.model } : {}),
          ...(metadata.instanceId ? { instanceId: metadata.instanceId } : {}),
          options: metadata.options,
        });
      }
      actor.effectiveCapabilities = session.effectiveCapabilities ?? capabilities;
      this.dependencies.repo.nativeSession(actor.id, session.nativeSessionId, session.instanceId);
      if (session.instanceId && session.instanceId !== thread?.live?.account) {
        const current = this.dependencies.repo.store.getThread(actor.id);
        if (current)
          this.dependencies.repo.store.appendEvents(
            actor.id,
            [
              {
                type: "thread.client.updated",
                changes: { live: { ...current.live, account: session.instanceId } },
              },
            ],
            this.dependencies.clock.now(),
          );
      }
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

  async select(
    actor: ThreadActor,
    model: string | undefined,
    options: TurnOptions | undefined,
  ): Promise<void> {
    if (model === undefined && options === undefined) return;
    const metadata = this.dependencies.repo.session(actor.id);
    const state = this.dependencies.repo.requireState(actor.id);
    const selectedModel = model ?? metadata.model;
    const selectedOptions = options ?? metadata.options ?? {};
    const selection = {
      provider: state.config.provider,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(metadata.instanceId ? { instanceId: metadata.instanceId } : {}),
      options: selectedOptions,
    };
    if (actor.session?.configure) await actor.session.configure(selection);
    else if (actor.session && Object.keys(selectedOptions).length > 0)
      throw new Error("Provider options configuration unavailable");
    else if (actor.session && selectedModel !== metadata.model) {
      if (actor.session.setModel && selectedModel) await actor.session.setModel(selectedModel);
      else {
        const capability =
          actor.effectiveCapabilities ??
          this.dependencies.registry.get(state.config.provider).capabilities;
        if (!capability.resume)
          throw new Error("Provider cannot change model without losing history");
        await this.close(actor, "idle");
      }
    }
    await actor.flush();
    try {
      this.dependencies.repo.store.atomic((db) => {
        const confirmed = this.dependencies.repo.requireState(actor.id);
        if (selectedModel && selectedModel !== metadata.model && confirmed.rootKey)
          actor.apply([{ type: "agent.linked", agent: confirmed.rootKey, model: selectedModel }]);
        db.prepare("UPDATE engine_sessions SET model=?,options=? WHERE thread_id=?").run(
          selectedModel ?? null,
          JSON.stringify(selectedOptions),
          actor.id,
        );
        const thread = this.dependencies.repo.store.getThread(actor.id);
        if (thread)
          this.dependencies.repo.store.appendEvents(
            actor.id,
            [
              {
                type: "thread.client.updated",
                changes: {
                  live: {
                    ...thread.live,
                    ...(selectedModel ? { model: selectedModel } : {}),
                    options: selectedOptions,
                  },
                },
              },
            ],
            this.dependencies.clock.now(),
          );
      });
    } catch (error) {
      this.dependencies.repo.evict(actor.id);
      throw error;
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
      actor.schedule();
      if (ownsGeneration && !actor.session && !actor.poisoned) this.dependencies.released(actor.id);
    }
  }
}
