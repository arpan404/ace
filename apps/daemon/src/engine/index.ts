import { randomUUID } from "node:crypto";
import { deriveThreadStatus, type Fact, type IdSource } from "@ace/core";
import type { CommandHandler } from "../commands.ts";
import type { Store } from "../store.ts";
import type { ThreadId } from "@ace/protocol";
import { ThreadActor, systemClock, type EngineClock } from "./actor.ts";
import { IntentWorkers } from "./workers.ts";
import { engineHandler } from "./handler.ts";
import { AdapterRegistry } from "./registry.ts";
import { EngineRepository, type Intent } from "./repository.ts";
export { AdapterRegistry } from "./registry.ts";
export type { EngineClock } from "./actor.ts";

export interface EngineOptions {
  ids?: IdSource;
  threadId?: () => string;
  registry?: AdapterRegistry;
  clock?: EngineClock;
  idleMs?: number;
  silenceMs?: number;
  onError?: (error: unknown) => void;
}
export class Engine {
  readonly handler: CommandHandler;
  private repo: EngineRepository;
  private registry: AdapterRegistry;
  private clock: EngineClock;
  private idleMs: number;
  private report: (error: unknown) => void;
  private actors = new Map<ThreadId, ThreadActor>();
  private sends: IntentWorkers;
  private controls: IntentWorkers;
  private steering: IntentWorkers;
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(store: Store, options: EngineOptions = {}) {
    this.repo = new EngineRepository(store, options.ids);
    this.registry = options.registry ?? new AdapterRegistry();
    this.clock = options.clock ?? systemClock;
    this.idleMs = options.idleMs ?? 30 * 60_000;
    const silenceMs = options.silenceMs ?? 60_000;
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 0) throw new Error("Invalid idleMs");
    if (!Number.isSafeInteger(silenceMs) || silenceMs < 0) throw new Error("Invalid silenceMs");
    this.report = options.onError ?? console.error;
    this.sends = new IntentWorkers((id) => this.work(this.actor(id)), this.report);
    this.steering = new IntentWorkers((id) => this.steer(this.actor(id)), this.report);
    this.controls = new IntentWorkers((id) => this.control(this.actor(id)), this.report);
    const handler = engineHandler(
      this.repo,
      this.registry,
      () => this.clock.now(),
      silenceMs,
      (id) => this.wake(id),
      options.threadId ?? randomUUID,
    );
    this.handler = {
      handle: (command, context) =>
        this.closing
          ? { commandId: command.id, ok: false, error: "daemon_shutting_down" }
          : handler.handle(command, context),
    };
    this.recover();
  }
  private actor(id: ThreadId): ThreadActor {
    let actor = this.actors.get(id);
    if (!actor) {
      actor = new ThreadActor(
        id,
        this.repo,
        this.clock,
        this.idleMs,
        () => this.wake(id),
        this.report,
      );
      this.actors.set(id, actor);
    }
    return actor;
  }
  private recover(): void {
    for (const state of this.repo.states()) {
      const live =
        Object.values(state.agents).some(
          (record) =>
            record.activeRun ||
            record.wakeUntil !== undefined ||
            !["idle", "failed", "interrupted"].includes(record.agent.status.state),
        ) ||
        Object.values(state.interactions).some((item) => item.state === "pending") ||
        Object.values(state.tasks).some((task) => task.status === "running");
      if (live)
        this.repo.apply(
          state.threadId,
          [
            {
              type: "process.exited",
              deliberate: false,
              message: "Daemon restarted while provider work was live",
            },
          ],
          this.clock.now(),
        );
    }
    for (const intent of this.repo.intents()) {
      if (
        intent.status === "running" ||
        intent.awaiting ||
        (intent.status === "pending" &&
          !["thread.send", "thread.create"].includes(intent.command.payload.type))
      ) {
        this.fail(
          intent,
          "Provider delivery was interrupted by daemon restart; execution is uncertain",
        );
      }
    }
    for (const state of this.repo.states()) {
      this.actor(state.threadId).syncQueue();
      this.actor(state.threadId).schedule();
      this.wake(state.threadId);
    }
  }
  private wake(id: ThreadId): void {
    if (this.closing) return;
    this.sends.wake(id);
    this.controls.wake(id);
    this.steering.wake(id);
  }
  private async control(actor: ThreadActor): Promise<void> {
    await actor.flush();
    if (actor.poisoned) return;
    if (actor.idleDue && actor.session) await this.closeSession(actor, "idle");
    if (
      !actor.session &&
      this.repo
        .intents(actor.id)
        .some((intent) => ["thread.create", "thread.send"].includes(intent.command.payload.type))
    )
      return;
    for (const intent of this.repo.intents(actor.id)) {
      if (this.closing) return;
      if (
        intent.status !== "pending" ||
        ["thread.create", "thread.send"].includes(intent.command.payload.type)
      )
        continue;
      await this.runIntent(actor, intent);
    }
  }
  private queue(actor: ThreadActor): void {
    actor.syncQueue();
  }
  private async work(actor: ThreadActor): Promise<void> {
    await actor.flush();
    if (actor.poisoned) {
      if (actor.session) await this.closeSession(actor, "user");
      for (const intent of this.repo.intents(actor.id))
        if (["pending", "queued"].includes(intent.status))
          this.fail(
            intent,
            "Thread stopped after a persistence failure; restart the daemon before retrying",
          );
      this.queue(actor);
      return;
    }
    if (actor.idleDue && actor.session) await this.closeSession(actor, "idle");
    for (const intent of this.repo.intents(actor.id)) {
      if (this.closing) return;
      if (!["pending", "queued"].includes(intent.status)) continue;
      const p = intent.command.payload;
      const send = p.type === "thread.send" || p.type === "thread.create";
      if (!send) continue;
      if (this.isSteer(intent)) continue;
      this.repo.mark(intent, "queued");
      this.queue(actor);
      const state = this.repo.requireState(actor.id);
      const status = deriveThreadStatus({ ...state, queueCount: 0 });
      if (
        this.repo.intents(actor.id).some((pending) => pending.awaiting) ||
        !["new", "done", "failed"].includes(status.state)
      )
        continue;
      await this.runIntent(actor, intent);
    }
    actor.schedule();
  }
  private isSteer(intent: Intent): boolean {
    const payload = intent.command.payload;
    if (payload.type !== "thread.send" || payload.delivery !== "steer") return false;
    const state = this.repo.requireState(intent.threadId);
    return (
      this.registry.has(state.config.provider) &&
      this.registry.get(state.config.provider).capabilities.steer
    );
  }
  private async steer(actor: ThreadActor): Promise<void> {
    await actor.flush();
    if (!actor.session || actor.poisoned) return;
    for (const intent of this.repo.intents(actor.id)) {
      if (this.closing) return;
      if (["pending", "queued"].includes(intent.status) && this.isSteer(intent))
        await this.runIntent(actor, intent);
    }
  }
  private async runIntent(actor: ThreadActor, intent: Intent): Promise<void> {
    const send = ["thread.create", "thread.send"].includes(intent.command.payload.type);
    this.repo.mark(intent, "running");
    if (send) {
      const state = this.repo.requireState(actor.id);
      const active = state.agents[state.rootKey ?? ""]?.activeRun;
      this.repo.beginSend(intent, !(this.isSteer(intent) && active));
    }
    this.queue(actor);
    try {
      await this.execute(actor, intent);
      await actor.flush();
      if (actor.poisoned) throw new Error("Provider frames could not be persisted");
      this.repo.mark(intent, "done");
    } catch (error) {
      await actor.flush();
      this.fail(intent, error instanceof Error ? error.message : String(error));
    }
    this.queue(actor);
    actor.schedule();
  }
  private async open(actor: ThreadActor): Promise<void> {
    if (actor.session) return;
    const state = this.repo.requireState(actor.id);
    const { adapter, capabilities } = this.registry.get(state.config.provider);
    const metadata = this.repo.session(actor.id);
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
          this.expireDelivery(actor);
          actor.apply([{ type: "process.exited", ...exit }]);
          this.wake(actor.id);
        }),
    });
    await actor.flush();
    if (generation !== actor.generation || actor.poisoned || this.closing) {
      await session.close("shutdown");
      throw new Error("Provider session closed while opening");
    }
    actor.session = session;
    this.repo.nativeSession(actor.id, session.nativeSessionId);
    this.wake(actor.id);
  }
  private async execute(actor: ThreadActor, intent: Intent): Promise<void> {
    const p = intent.command.payload;
    if (p.type === "thread.create" || p.type === "thread.send") {
      await this.open(actor);
      const capabilities = this.registry.get(
        this.repo.requireState(actor.id).config.provider,
      ).capabilities;
      const session = actor.session;
      if (!session) throw new Error("Provider session exited before send");
      await session.send(
        p.input,
        p.type === "thread.send" && p.delivery === "steer" && capabilities.steer
          ? "steer"
          : "queue",
      );
      return;
    }
    if (!actor.session) throw new Error("Provider session is not live");
    const state = this.repo.requireState(actor.id);
    if (p.type === "thread.interrupt") {
      const agent = p.agentId === undefined ? undefined : state.indexes.agentKeysById[p.agentId];
      const { capabilities } = this.registry.get(state.config.provider);
      if (p.cascade && !capabilities.interruptCascades) {
        const target = p.agentId ?? state.agents[state.rootKey ?? ""]?.agent.id;
        const descendants = (id: string): string[] =>
          Object.keys(state.indexes.childrenByParent[id] ?? {}).flatMap((key) =>
            descendants(state.agents[key]?.agent.id ?? "").concat(key),
          );
        for (const key of target ? descendants(target) : [])
          await actor.session.interrupt({ agent: key, cascade: false });
      }
      await actor.session.interrupt({
        ...(agent === undefined ? {} : { agent }),
        cascade: p.cascade,
      });
    } else if (p.type === "interaction.resolve") {
      const entry = Object.entries(state.interactions).find(
        ([, item]) => item.id === p.interactionId,
      );
      if (!entry || entry[1].state !== "pending")
        throw new Error("Interaction is no longer pending");
      await actor.session.resolve(entry[0], p.resolution);
      await actor.flush();
      if (this.repo.requireState(actor.id).interactions[entry[0]]?.id !== p.interactionId) return;
      actor.apply([
        {
          type: "interaction.closed",
          interaction: entry[0],
          state: "resolved",
          resolution: p.resolution,
          resolvedBy: intent.command.deviceId,
        },
      ]);
    } else if (p.type === "background_task.stop") {
      const entry = Object.entries(state.tasks).find(([, task]) => task.id === p.taskId);
      if (!entry || entry[1].status !== "running") throw new Error("Task is no longer running");
      await actor.session.stopTask(entry[0]);
    }
  }
  private fail(intent: Intent, message: string): void {
    this.repo.store.atomic(() => {
      this.repo.mark(intent, "failed", message);
      const fact: Fact = {
        type: "item.upsert",
        agent: "root",
        item: `intent:${intent.id}`,
        draft: {
          type: "notice",
          level: "error",
          text: `${intent.command.payload.type}: ${message}`,
          complete: true,
          raw: [],
        },
      };
      this.repo.apply(intent.threadId, [fact], this.clock.now());
    });
  }
  private expireDelivery(actor: ThreadActor): void {
    for (const intent of this.repo.intents(actor.id))
      if (intent.awaiting)
        this.fail(intent, "Provider exited before turn acknowledgement; execution is uncertain");
    this.queue(actor);
  }
  private async closeSession(
    actor: ThreadActor,
    reason: "idle" | "user" | "shutdown",
  ): Promise<void> {
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
        this.expireDelivery(actor);
        actor.idleDue = false;
        this.repo.apply(
          actor.id,
          [{ type: "process.exited", deliberate: !actor.poisoned }],
          this.clock.now(),
        );
      }
      actor.schedule();
    }
  }
  /** Drain accepted commands and frames. Does not wait for queued work to become runnable. */
  async flush(): Promise<void> {
    await Promise.resolve();
    do {
      await Promise.all([this.sends.flush(), this.controls.flush(), this.steering.flush()]);
      await Promise.all([...this.actors.values()].map((actor) => actor.flush()));
    } while (this.sends.active || this.controls.active || this.steering.active);
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
      this.sends.stop();
      this.controls.stop();
      this.steering.stop();
      for (const actor of this.actors.values()) {
        if (!actor.session) actor.lifetime?.abort();
      }
      await Promise.all(
        [...this.actors.values()].map(async (actor) => {
          try {
            await this.closeSession(actor, "shutdown");
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
