import { ModelSelectionError } from "./models.ts";
import { SessionOpenError } from "@ace/provider-kit/open-error";
import type { ProviderErrorDetails } from "@ace/protocol";
import type { CommandId } from "@ace/protocol";
import type { PrepareInput } from "./input.ts";
import type { Recovery } from "./recovery.ts";
import type { EngineRepository, Intent, IntentHeader } from "./repository.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { ThreadActor, EngineClock } from "./actor.ts";
import type { Sessions } from "./sessions.ts";
import type { ThreadTransitions } from "./transitions.ts";
import type { Fact } from "@ace/core";
import {
  executeIntent,
  DeliveryDeferred,
  DeliveryNotStarted,
  InteractionUnavailable,
} from "./delivery.ts";
interface Dependencies {
  repo: EngineRepository;
  clock: EngineClock;
  registry: AdapterRegistry;
  sessions: Sessions;
  recovery: Recovery;
  prepareInput: PrepareInput | undefined;
  beforeSend:
    | ((threadId: IntentHeader["threadId"], commandId: CommandId) => Promise<void>)
    | undefined;
  transitions: ThreadTransitions;
  releaseGuards(intent: IntentHeader): void;
  invalidateContext(threadId: IntentHeader["threadId"]): void;
  isSteer(intent: IntentHeader): boolean;
}
/** Claims, acknowledgements and uncertain delivery have one owner. */
export class IntentDelivery {
  private dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }
  async run(actor: ThreadActor, candidate: IntentHeader): Promise<void> {
    await this.dependencies.repo.store.writable();
    const send = ["thread.create", "thread.send", "thread.fork"].includes(candidate.kind);
    const editableSend = ["thread.create", "thread.send"].includes(candidate.kind);
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
      else if (intent.kind === "thread.switch" || intent.kind === "thread.merge") {
        const binding = {
          provider: this.dependencies.repo.requireState(actor.id).config.provider,
          instanceId: this.dependencies.repo.session(actor.id).instanceId,
        };
        await this.dependencies.transitions.execute(actor, intent);
        if (intent.kind === "thread.switch") {
          const queue = this.dependencies.repo.queue.get(actor.id);
          if (queue.reason === "model_unavailable") this.dependencies.recovery.automatic(actor.id);
          this.dependencies.invalidateContext(actor.id);
          if (
            binding.provider !== this.dependencies.repo.requireState(actor.id).config.provider ||
            binding.instanceId !== this.dependencies.repo.session(actor.id).instanceId
          )
            this.dependencies.recovery.bindingChanged(actor.id);
        }
      } else
        await executeIntent(
          actor,
          intent,
          this.dependencies.repo,
          this.dependencies.registry,
          this.dependencies.sessions,
          this.dependencies.transitions,
          this.dependencies.prepareInput,
          this.dependencies.beforeSend,
        );
      await actor.flush();
      if (actor.poisoned) throw new Error("Provider frames could not be persisted");
      if (this.dependencies.repo.pending.commandStatus(intent.commandId) === "running")
        this.dependencies.repo.mark(intent, "done");
      this.dependencies.releaseGuards(intent);
    } catch (error) {
      await actor.flush();
      const acknowledged = this.dependencies.repo.pending.acknowledged(intent.id);
      if (this.dependencies.repo.pending.commandStatus(intent.commandId) === "failed") {
        this.dependencies.releaseGuards(intent);
      } else if (continuation && acknowledged) {
        // Admission transfers ownership even if the transport loses the reply.
        // Keep the durable run correlation until the admitted run actually starts.
        this.dependencies.repo.mark(intent, "done");
        this.dependencies.transitions.delivered(actor.id);
        this.dependencies.recovery.release(actor.id, holdToken);
      } else if (
        send &&
        !acknowledged &&
        (error instanceof DeliveryDeferred ||
          (this.dependencies.repo.pending.submitted(intent.id) === undefined &&
            this.dependencies.repo.queue.get(actor.id).reason === "stopped"))
      ) {
        this.dependencies.repo.queue.clearUncertain(intent.id);
        this.dependencies.repo.pending.defer(intent);
        this.dependencies.repo.beginSend(intent, undefined);
        this.dependencies.repo.queue.reconcileUncertainty(actor.id, this.dependencies.clock.now());
      } else {
        // RPC failure cannot undo native consumption, nor prove nonconsumption.
        if (send && acknowledged) this.dependencies.transitions.delivered(actor.id);
        const undelivered =
          editableSend &&
          !acknowledged &&
          (error instanceof DeliveryNotStarted ||
            this.dependencies.repo.pending.submitted(intent.id) === undefined);
        const uncertain = editableSend && !acknowledged && !undelivered;
        if (uncertain) this.dependencies.repo.queue.uncertain(intent.id);
        const message = error instanceof Error ? error.message : String(error);
        const openingFailure =
          error instanceof SessionOpenError
            ? error
            : error instanceof DeliveryNotStarted && error.cause instanceof SessionOpenError
              ? error.cause
              : undefined;
        const details = openingFailure
          ? {
              provider: this.dependencies.repo.requireState(actor.id).config.provider,
              code: openingFailure.code,
              title: openingFailure.title,
              detail: openingFailure.detail,
            }
          : undefined;
        const unavailable =
          error instanceof ModelSelectionError ||
          details?.code === "model_unavailable" ||
          /(?:^|[\s:])model_unavailable(?:$|[\s:])/.test(details?.detail ?? message);
        if (undelivered) this.retainInput(intent, message, unavailable, details);
        else if (continuation && unavailable) {
          this.dependencies.repo.mark(intent, "failed", message);
          this.dependencies.releaseGuards(intent);
          this.dependencies.repo.queue.set(
            actor.id,
            { paused: true, reason: "model_unavailable", resumeAt: null, timerAction: null },
            this.dependencies.clock.now(),
          );
        } else
          this.fail(
            intent,
            message,
            error instanceof InteractionUnavailable
              ? error.code
              : uncertain
                ? "delivery_uncertain"
                : undefined,
            details,
          );
        if (uncertain)
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
      if (this.dependencies.repo.backend(actor.id) === "cursor-sdk")
        throw new Error("Cursor SDK account migration requires a fresh portable context handoff");
      await this.dependencies.sessions.close(actor, "user");
      await this.dependencies.recovery.migrate(actor.id, p.instanceId);
    }
    if (!this.dependencies.recovery.owns(actor.id, token)) return;
    const queue = this.dependencies.repo.queue.get(actor.id);
    if (queue.continuation) {
      if (
        !this.dependencies.repo.session(actor.id).nativeSessionId &&
        !this.dependencies.repo.transitions.get(actor.id).handoff
      )
        throw new Error("Native history is unavailable for continuation");
      // Closing an existing limited session prevents old frames from acknowledging replacement work.
      if (queue.limited && actor.session) await this.dependencies.sessions.close(actor, "user");
      await this.dependencies.sessions.open(actor);
      if (!this.dependencies.recovery.begin(actor.id, token)) return;
      this.dependencies.repo.beginSend(intent, intent.id);
      const session = actor.session;
      if (!session) throw new Error("Provider exited before continuation");
      const key = `input:${intent.command.id}`;
      this.dependencies.repo.syntheticInput(
        actor.id,
        key,
        queue.trigger === "restart" ? "continue" : queue.continuation,
        { kind: queue.trigger ?? "restart", commandId: intent.command.id },
        this.dependencies.clock.now(),
      );
      const input = [
        ...this.dependencies.transitions
          .input(actor.id)
          .map((text) => ({ type: "text" as const, text })),
        {
          type: "text" as const,
          text: queue.trigger === "restart" ? "continue" : queue.continuation,
        },
      ];
      this.dependencies.repo.inputs.sending(
        actor.id,
        key,
        input,
        this.dependencies.repo.requireState(actor.id).config.provider,
        actor.generation,
      );
      this.dependencies.repo.pending.submit(intent, actor.generation);
      await session.send(input, "queue", intent.command.id);
      this.dependencies.transitions.delivered(actor.id);
    } else {
      this.dependencies.repo.beginSend(intent, undefined);
      this.dependencies.recovery.begin(actor.id, token);
    }
    await actor.flush();
    this.dependencies.recovery.release(actor.id, token);
  }
  fail(intent: IntentHeader, message: string, code?: string, details?: ProviderErrorDetails): void {
    this.dependencies.repo.store.atomic(() => {
      this.dependencies.repo.mark(intent, "failed", message);
      this.reportFailure(intent, message, code, details);
    });
  }
  private retainInput(
    intent: IntentHeader,
    message: string,
    unavailable: boolean,
    details?: ProviderErrorDetails,
  ): void {
    this.dependencies.repo.store.atomic(() => {
      this.dependencies.repo.queue.clearUncertain(intent.id);
      this.dependencies.repo.mark(intent, "queued", message);
      this.dependencies.repo.beginSend(intent, undefined);
      this.dependencies.repo.queue.set(
        intent.threadId,
        {
          paused: true,
          reason: unavailable ? "model_unavailable" : "not_sent",
          resumeAt: null,
          timerAction: null,
        },
        this.dependencies.clock.now(),
      );
      this.reportFailure(intent, message, "input_queued", details);
    });
  }
  private reportFailure(
    intent: IntentHeader,
    message: string,
    code = "delivery_failed",
    details?: ProviderErrorDetails,
  ): void {
    this.dependencies.releaseGuards(intent);
    if (intent.kind === "thread.switch") {
      const pending = this.dependencies.repo.store.getThread(intent.threadId)?.switch;
      if (pending)
        this.dependencies.repo.store.appendEvents(
          intent.threadId,
          [
            {
              type: "thread.updated",
              switch: {
                ...pending,
                state: "failed",
                error: message.slice(0, 2048),
                at: this.dependencies.clock.now(),
              },
            },
          ],
          this.dependencies.clock.now(),
        );
    }
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
        level: code === "input_queued" ? "info" : "error",
        text:
          code === "input_queued"
            ? "Message kept in queue"
            : code === "delivery_uncertain"
              ? "This message may have run"
              : code.startsWith("interaction_")
                ? message
                : ["thread.send", "thread.create"].includes(intent.kind)
                  ? "Message not sent"
                  : "Action failed",
        commandId: intent.commandId,
        ...(intent.resolutionId ? { interactionId: intent.resolutionId } : {}),
        code,
        title:
          code === "input_queued"
            ? "Message kept in queue"
            : code === "delivery_uncertain"
              ? "This message may have run"
              : code.startsWith("interaction_")
                ? "This question is no longer active"
                : intent.kind === "thread.send" || intent.kind === "thread.create"
                  ? "Not sent"
                  : "Action failed",
        detail: message.slice(0, 4096),
        complete: true,
        raw: [
          {
            type: "delivery_error",
            data: { operation: intent.kind, message: message.slice(0, 4096) },
          },
        ],
        ...(details ? { details } : {}),
      },
    };
    this.dependencies.repo.apply(intent.threadId, [fact], this.dependencies.clock.now());
  }
  expire(actor: ThreadActor, generation: number): void {
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
      if (intent.awaiting && intent.submittedGeneration === generation && !intent.acknowledged) {
        if (intent.kind === "thread.send" || intent.kind === "thread.create")
          this.dependencies.repo.queue.uncertain(intent.id);
        this.fail(
          intent,
          "Provider disconnected before confirming this message. It may have run.",
          "delivery_uncertain",
        );
        this.dependencies.repo.queue.set(
          actor.id,
          { paused: true, reason: "uncertain" },
          this.dependencies.clock.now(),
        );
      }
    actor.syncQueue();
  }
}
