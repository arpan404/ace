import type { PrepareInput } from "./input.ts";
import type { Recovery } from "./recovery.ts";
import type { EngineRepository, Intent, IntentHeader } from "./repository.ts";
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
  isSteer(intent: IntentHeader): boolean;
}
/** Claims, acknowledgements and uncertain delivery have one owner. */
export class IntentDelivery {
  private dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }
  async run(actor: ThreadActor, candidate: IntentHeader): Promise<void> {
    const send = ["thread.create", "thread.send"].includes(candidate.kind);
    const continuation = ["thread.resume", "queue.resume", "thread.limit"].includes(candidate.kind);
    const holdToken = this.dependencies.repo.queue.get(actor.id).holdToken;
    const intent = this.dependencies.repo.claim(candidate);
    if (!intent) return;
    if (send) this.dependencies.repo.queue.set(actor.id, {}, this.dependencies.clock.now());
    if (send) {
      const state = this.dependencies.repo.requireState(actor.id);
      const active = state.agents[state.rootKey ?? ""]?.activeRun;
      const outstanding = this.dependencies.repo.pending.awaiting(actor.id);
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
      const acknowledged = this.dependencies.repo.pending.acknowledged(intent.id);
      if (continuation && acknowledged) {
        // Admission transfers ownership even if the transport loses the reply.
        // Keep the durable run correlation until the admitted run actually starts.
        this.dependencies.repo.mark(intent, "done");
        this.dependencies.recovery.release(actor.id, holdToken);
      } else if (send && error instanceof DeliveryDeferred && !acknowledged) {
        this.dependencies.repo.queue.clearUncertain(intent.id);
        this.dependencies.repo.mark(intent, "queued");
        this.dependencies.repo.beginSend(intent, undefined);
        this.dependencies.repo.queue.set(actor.id, {}, this.dependencies.clock.now());
      } else {
        // RPC failure cannot undo native consumption, nor prove nonconsumption.
        if (send && !acknowledged) this.dependencies.repo.queue.uncertain(intent.id);
        this.fail(intent, error instanceof Error ? error.message : String(error));
        if (send && !acknowledged)
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
      await session.send([{ type: "text", text: queue.continuation }], "queue", intent.command.id);
    } else {
      this.dependencies.repo.beginSend(intent, undefined);
      this.dependencies.recovery.begin(actor.id, token);
    }
    await actor.flush();
    this.dependencies.recovery.release(actor.id, token);
  }
  fail(intent: IntentHeader, message: string): void {
    this.dependencies.repo.store.atomic(() => {
      this.dependencies.repo.mark(intent, "failed", message);
      if (["thread.resume", "queue.resume", "thread.limit"].includes(intent.kind))
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
          text: `${intent.kind}: ${message}`,
          complete: true,
          raw: [],
        },
      };
      this.dependencies.repo.apply(intent.threadId, [fact], this.dependencies.clock.now());
    });
  }
  expire(actor: ThreadActor): void {
    if (this.dependencies.repo.pending.recoveryAcknowledgement(actor.id)) {
      this.dependencies.recovery.capture(actor.id);
      this.dependencies.repo.pending.finishContinuation(actor.id);
      const queue = this.dependencies.repo.queue.get(actor.id);
      this.dependencies.repo.queue.set(
        actor.id,
        {
          paused: true,
          reason: queue.limited ? "limit" : "restart",
          holdToken: queue.holdToken + 1,
        },
        this.dependencies.clock.now(),
      );
    }
    for (const intent of this.dependencies.repo.pending.headers(actor.id))
      if (intent.awaiting) {
        if (intent.kind === "thread.send" || intent.kind === "thread.create")
          this.dependencies.repo.queue.uncertain(intent.id);
        this.fail(intent, "Provider exited before turn acknowledgement; execution is uncertain");
        this.dependencies.repo.queue.set(
          actor.id,
          { paused: true, reason: "uncertain" },
          this.dependencies.clock.now(),
        );
      }
    actor.syncQueue();
  }
}
