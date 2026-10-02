import { executeIntent } from "./delivery.ts";
import { Sessions } from "./sessions.ts";
import { randomUUID } from "node:crypto";
import { deriveThreadStatus, type Fact, type IdSource } from "@ace/core";
import type { CommandHandler } from "../commands.ts";
import type { Store } from "../store.ts";
import type { ThreadId } from "@ace/protocol";
import { ThreadActor, systemClock, type EngineClock } from "./actor.ts";
import { engineLimits, type EngineLimits } from "./limits.ts";
import { IntentWorkers } from "./workers.ts";
import { engineHandler } from "./handler.ts";
import { AdapterRegistry } from "./registry.ts";
import { EngineRepository, type Intent } from "./repository.ts";
export { AdapterRegistry } from "./registry.ts";
export type { EngineClock } from "./actor.ts";

export interface EngineOptions {
  limits?: Partial<EngineLimits>;
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
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(store: Store, options: EngineOptions = {}) {
    this.limits = engineLimits(options.limits);
    this.repo = new EngineRepository(store, options.ids, this.limits.maxActiveThreads);
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
      repo: this.repo,
      registry: this.registry,
      clock: this.clock,
      closing: () => this.closing,
      wake: (id) => this.wake(id),
      expireDelivery: (actor) => this.expireDelivery(actor),
      released: (id) => {
        this.repo.release(id);
        this.wakeQueued();
      },
    });
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
  private recover(): void {
    const uncertain = new Set<ThreadId>();
    for (const state of this.repo.states()) {
      const live =
        Object.values(state.agents).some(
          (record) =>
            record.activeRun ||
            record.wakeUntil !== undefined ||
            !["idle", "failed", "interrupted"].includes(record.agent.status.state),
        ) ||
        Object.keys(state.indexes.pendingInteractions).length > 0 ||
        Object.keys(state.indexes.runningTasks).length > 0;
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
        uncertain.add(intent.threadId);
        this.fail(
          intent,
          "Provider delivery was interrupted by daemon restart; execution is uncertain",
        );
      }
    }
    for (const state of this.repo.states()) {
      const count = this.repo.queuedCount(state.threadId);
      if (state.queueCount > count && !uncertain.has(state.threadId))
        this.repo.apply(
          state.threadId,
          [
            {
              type: "item.upsert",
              agent: "root",
              item: "engine:recovered-queue",
              draft: {
                type: "notice",
                level: "error",
                complete: true,
                text: "Recovered untracked queue state after restart; execution is uncertain",
              },
            },
          ],
          this.clock.now(),
        );
      if (state.queueCount !== count)
        this.repo.apply(state.threadId, [{ type: "queue.changed", count }], this.clock.now());
      if (
        this.repo
          .intents(state.threadId)
          .some((intent) => ["pending", "queued"].includes(intent.status)) &&
        this.repo.reserve(state.threadId)
      )
        this.wake(state.threadId);
    }
  }

  private wakeQueued(): void {
    if (this.closing) return;
    for (const intent of this.repo.intents())
      if (["pending", "queued"].includes(intent.status) && this.repo.reserve(intent.threadId))
        this.wake(intent.threadId);
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
    if (actor.idleDue && actor.session) await this.sessions.close(actor, "idle");
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
      if (actor.session) await this.sessions.close(actor, "user");
      for (const intent of this.repo.intents(actor.id))
        if (["pending", "queued"].includes(intent.status))
          this.fail(
            intent,
            "Thread stopped after a persistence failure; restart the daemon before retrying",
          );
      this.queue(actor);
      return;
    }
    if (actor.idleDue && actor.session) await this.sessions.close(actor, "idle");
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
    if (actor.poisoned) return;
    for (const intent of this.repo.intents(actor.id)) {
      if (this.closing) return;
      if (["pending", "queued"].includes(intent.status) && this.isSteer(intent)) {
        if (
          !actor.session &&
          this.repo
            .intents(actor.id)
            .some(
              (pending) =>
                ["pending", "queued", "running"].includes(pending.status) &&
                ["thread.create", "thread.send"].includes(pending.command.payload.type) &&
                !this.isSteer(pending),
            )
        )
          return;
        await this.runIntent(actor, intent);
      }
    }
  }
  private async runIntent(actor: ThreadActor, intent: Intent): Promise<void> {
    const send = ["thread.create", "thread.send"].includes(intent.command.payload.type);
    this.repo.mark(intent, "running");
    if (send) {
      const state = this.repo.requireState(actor.id);
      const active = state.agents[state.rootKey ?? ""]?.activeRun;
      const outstanding = this.repo.intents(actor.id).find((pending) => pending.awaiting);
      const target = this.isSteer(intent)
        ? active
          ? undefined
          : (outstanding?.ackTarget ?? intent.id)
        : intent.id;
      this.repo.beginSend(intent, target);
    }
    this.queue(actor);
    try {
      await executeIntent(actor, intent, this.repo, this.registry, this.sessions);
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
  /** Read the original JSON bytes of an oversized raw payload's data envelope. */
  readRawBlob(id: string): Uint8Array | undefined {
    return this.repo.readRawBlob(id);
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
