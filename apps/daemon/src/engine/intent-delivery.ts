import type { PrepareInput } from "./input.ts";
import type { Recovery } from "./recovery.ts";
import type { EngineRepository, Intent } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { ThreadActor, EngineClock } from "./actor.ts";
import type { Sessions } from "./sessions.ts";
import type { Fact } from "@ace/core";
import { executeIntent, DeliveryDeferred } from "./delivery.ts";
interface Dependencies {
  repo: EngineRepository;
  clock: EngineClock;
  registry: AdapterRegistry;
  sessions: Sessions;
  recovery: Recovery;
  prepareInput: PrepareInput | undefined;
  isSteer(intent: Intent): boolean;
}
/** Claims, acknowledgements and uncertain delivery have one owner. */
export class IntentDelivery {
  private dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }
  async run(actor: ThreadActor, intent: Intent): Promise<void> {
    const send = ["thread.create", "thread.send"].includes(intent.command.payload.type);
    const claimed = this.dependencies.repo.claim(intent);
    if (!claimed) return;
    intent = claimed;
    if (send) this.dependencies.repo.queue.set(actor.id, {}, this.dependencies.clock.now());
    if (send) {
      const state = this.dependencies.repo.requireState(actor.id);
      const active = state.agents[state.rootKey ?? ""]?.activeRun;
      const outstanding = this.dependencies.repo
        .intents(actor.id)
        .find((pending) => pending.awaiting);
      const target = this.dependencies.isSteer(intent)
        ? active
          ? undefined
          : (outstanding?.ackTarget ?? intent.id)
        : intent.id;
      this.dependencies.repo.beginSend(intent, target);
    }
    actor.syncQueue();
    try {
      if (["thread.resume", "queue.resume", "thread.limit"].includes(intent.command.payload.type))
        await this.resume(actor, intent);
      else
        await executeIntent(
          actor,
          intent,
          this.dependencies.repo,
          this.dependencies.registry,
          this.dependencies.sessions,
          this.dependencies.prepareInput,
        );
      await actor.flush();
      if (actor.poisoned) throw new Error("Provider frames could not be persisted");
      this.dependencies.repo.mark(intent, "done");
    } catch (error) {
      await actor.flush();
      if (
        (this.dependencies.repo.queue.get(actor.id).limited || error instanceof DeliveryDeferred) &&
        (intent.command.payload.type === "thread.send" ||
          intent.command.payload.type === "thread.create")
      ) {
        if (error instanceof DeliveryDeferred)
          this.dependencies.repo.queue.clearUncertain(intent.id);
        this.dependencies.repo.mark(intent, "queued");
        this.dependencies.repo.beginSend(intent, undefined);
        this.dependencies.repo.queue.set(actor.id, {}, this.dependencies.clock.now());
      } else {
        if (send) this.dependencies.repo.queue.uncertain(intent.id);
        this.fail(intent, error instanceof Error ? error.message : String(error));
        if (send)
          this.dependencies.repo.queue.set(
            actor.id,
            { paused: true, reason: "uncertain" },
            this.dependencies.clock.now(),
          );
      }
    }
    actor.syncQueue();
    actor.schedule();
  }
  private async resume(actor: ThreadActor, intent: Intent): Promise<void> {
    const token = this.dependencies.repo.queue.get(actor.id).holdToken;
    const p = intent.command.payload;
    if (p.type === "thread.limit" && p.action === "migrate_now") {
      await this.dependencies.sessions.close(actor, "user");
      await this.dependencies.recovery.migrate(actor.id, p.instanceId);
    }
    if (!this.dependencies.recovery.owns(actor.id, token)) return;
    const queue = this.dependencies.repo.queue.get(actor.id);
    if (queue.continuation) {
      if (!this.dependencies.repo.session(actor.id).nativeSessionId)
        throw new Error("Native history is unavailable for continuation");
      // Closing an existing limited session prevents old frames from acknowledging replacement work.
      if (queue.limited && actor.session) await this.dependencies.sessions.close(actor, "user");
      await this.dependencies.sessions.open(actor);
      if (!this.dependencies.recovery.begin(actor.id, token)) return;
      this.dependencies.repo.beginSend(intent, intent.id);
      const session = actor.session;
      if (!session) throw new Error("Provider exited before continuation");
      await session.send([{ type: "text", text: queue.continuation }], "queue");
    } else {
      this.dependencies.repo.beginSend(intent, undefined);
      this.dependencies.recovery.begin(actor.id, token);
    }
    await actor.flush();
    this.dependencies.recovery.release(actor.id, token);
  }
  fail(intent: Intent, message: string): void {
    this.dependencies.repo.store.atomic(() => {
      this.dependencies.repo.mark(intent, "failed", message);
      if (["thread.resume", "queue.resume", "thread.limit"].includes(intent.command.payload.type))
        this.dependencies.repo.queue.set(
          intent.threadId,
          { paused: true, reason: "manual" },
          this.dependencies.clock.now(),
        );
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
      this.dependencies.repo.apply(intent.threadId, [fact], this.dependencies.clock.now());
    });
  }
  expire(actor: ThreadActor): void {
    for (const intent of this.dependencies.repo.intents(actor.id))
      if (intent.awaiting) {
        if (this.dependencies.repo.queue.get(actor.id).limited) {
          this.dependencies.repo.mark(intent, "queued");
          this.dependencies.repo.beginSend(intent, undefined);
        } else {
          if (
            intent.command.payload.type === "thread.send" ||
            intent.command.payload.type === "thread.create"
          )
            this.dependencies.repo.queue.uncertain(intent.id);
          this.fail(intent, "Provider exited before turn acknowledgement; execution is uncertain");
          this.dependencies.repo.queue.set(
            actor.id,
            { paused: true, reason: "uncertain" },
            this.dependencies.clock.now(),
          );
        }
      }
    actor.syncQueue();
  }
}
