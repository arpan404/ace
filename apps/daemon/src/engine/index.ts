import type { PrepareInput } from "./input.ts";
import { Recovery, RecoveryPreferences, type RecoveryPorts } from "./recovery.ts";
import { ContextMeters } from "./context-meter.ts";
import { recoverEngine } from "./restart.ts";
import { IntentDelivery } from "./intent-delivery.ts";
import { Sessions } from "./sessions.ts";
import { randomUUID } from "node:crypto";
import { deriveThreadStatus, type IdSource } from "@ace/core";
import type { CommandHandler } from "../commands.ts";
import type { Store } from "../store.ts";
import type { Command, ThreadId, QueueSnapshot, QueueGet } from "@ace/protocol";
import { ThreadActor, systemClock, type EngineClock } from "./actor.ts";
import { engineLimits, type EngineLimits } from "./limits.ts";
import { IntentWorkers } from "./workers.ts";
import { engineHandler } from "./handler.ts";
import { AdapterRegistry } from "./registry.ts";
import { EngineRepository, type IntentHeader } from "./repository.ts";
export { AdapterRegistry } from "./registry.ts";
export type { EngineClock } from "./actor.ts";

export interface EngineOptions {
  prepareInput?: PrepareInput;
  recovery?: RecoveryPorts;
  preferences?: Partial<RecoveryPreferences>;
  limits?: Partial<EngineLimits>;
  sessionContext?: NonNullable<ConstructorParameters<typeof Sessions>[0]["context"]>;
  ids?: IdSource;
  threadId?: () => string;
  commandId?: () => string;
  registry?: AdapterRegistry;
  clock?: EngineClock;
  idleMs?: number;
  silenceMs?: number;
  onError?: (error: unknown) => void;
}
export class Engine {
  readonly handler: CommandHandler;
  private limits: EngineLimits;
  private repo: EngineRepository;
  private registry: AdapterRegistry;
  private clock: EngineClock;
  private idleMs: number;
  private report: (error: unknown) => void;
  private actors = new Map<ThreadId, ThreadActor>();
  private sends: IntentWorkers;
  private controls: IntentWorkers;
  private steering: IntentWorkers;
  private sessions: Sessions;
  private recovery: Recovery;
  private meters: ContextMeters;
  private delivery: IntentDelivery;
  private readyPromise: Promise<void>;
  private readyState = false;
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(store: Store, options: EngineOptions = {}) {
    this.limits = engineLimits(options.limits);
    this.repo = new EngineRepository(
      store,
      options.ids,
      this.limits.maxActiveThreads,
      options.commandId,
    );
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
    this.sessions = new Sessions({
      ...(options.sessionContext ? { context: options.sessionContext } : {}),
      repo: this.repo,
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
    this.delivery = new IntentDelivery({
      repo: this.repo,
      clock: this.clock,
      registry: this.registry,
      sessions: this.sessions,
      recovery: this.recovery,
      prepareInput: options.prepareInput,
      isSteer: (intent) => this.isSteer(intent),
    });
    this.meters = new ContextMeters(store, options.recovery?.contextWindow);
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
      options.threadId ?? randomUUID,
      this.recovery,
    );
    this.handler = {
      handle: (command, context) =>
        this.closing
          ? { commandId: command.id, ok: false, error: "daemon_shutting_down" }
          : !this.readyState
            ? { commandId: command.id, ok: false, error: "engine_starting" }
            : handler.handle(command, context),
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
    if (options.recovery?.preferences) {
      this.readyPromise = (async () => {
        await recovery.prepare();
        for (const state of repo.states()) await recovery.prepare(state.threadId);
        if (!this.closing) recover();
        this.readyState = true;
      })();
    } else {
      recover();
      this.readyState = true;
      this.readyPromise = Promise.resolve();
    }
  }
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
      );
      this.actors.set(id, actor);
    }
    return actor;
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
  sessionMetadata(id: ThreadId) {
    return this.repo.session(id);
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
  async prepareCommand(command: Command): Promise<void> {
    await this.readyPromise;
    await this.recovery.prepare(
      "threadId" in command.payload ? command.payload.threadId : undefined,
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
      this.repo.pending.controls(id).length ||
      (!queue.paused && !queue.limited && this.repo.pending.message(id))
    )
      return;
    if (this.repo.reservedSlot(id)) {
      this.repo.release(id);
      this.wakeQueued();
    }
  }
  private wake(id: ThreadId): void {
    if (this.closing) return;
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
    if (actor.idleDue && actor.session) await this.sessions.close(actor, "idle");
    if (this.closing) return;
    const recovery = this.repo.pending.recovery(actor.id);
    if (recovery) {
      await this.delivery.run(actor, recovery);
      this.wake(actor.id);
      return;
    }
    const queue = this.repo.queue.get(actor.id);
    if (queue.paused || queue.limited) {
      this.releaseDormant(actor.id);
      actor.schedule();
      return;
    }
    const first = this.repo.pending.message(actor.id);
    const intent = first && this.isSteer(first) ? this.repo.pending.queuedMessage(actor.id) : first;
    if (intent) {
      this.repo.mark(intent, "queued");
      this.syncQueue(actor);
      const state = this.repo.requireState(actor.id);
      const status = deriveThreadStatus({ ...state, queueCount: state.queueSources.provider });
      if (
        !this.repo.pending.awaiting(actor.id) &&
        ["new", "done", "failed"].includes(status.state)
      ) {
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
    const state = this.repo.requireState(intent.threadId);
    return (
      Boolean(this.actors.get(intent.threadId)?.session) &&
      !this.repo.queue.get(intent.threadId).paused &&
      !this.repo.queue.get(intent.threadId).limited &&
      this.registry.has(state.config.provider) &&
      (
        this.actors.get(intent.threadId)?.effectiveCapabilities ??
        this.registry.get(state.config.provider).capabilities
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
    await this.readyPromise;
    await Promise.resolve();
    do {
      await Promise.all([this.sends.flush(), this.controls.flush(), this.steering.flush()]);
      await Promise.all([...this.actors.values()].map((actor) => actor.flush()));
      await this.recovery.flush();
    } while (this.sends.active || this.controls.active || this.steering.active);
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
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
