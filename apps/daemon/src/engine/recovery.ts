import { restatesSelection } from "./input-delivery.ts";
import { handleQueue } from "./queue-commands.ts";
import { lostWork } from "./lost-work.ts";
import { z } from "zod";
import {
  Command,
  maxMessageBytes,
  type CommandResult,
  type ThreadId,
  type CommandPayload,
  type EventPayload,
} from "@ace/protocol";
import { continueMessage, type Fact, type ThreadState } from "@ace/core";
import type { EngineRepository } from "./repository.ts";
import { maxMessages, isSend } from "./queue-store.ts";
import type { EngineClock } from "./actor.ts";
import type { ContextWindowLookup } from "./context-meter.ts";

export const RecoveryPreferences = z.object({
  followUpBehavior: z.enum(["steer", "queue"]).default("queue"),
  limitPolicy: z
    .enum(["manual", "resume_at_reset", "snooze_until_reset", "migrate_now"])
    .default("manual"),
});
export type RecoveryPreferences = z.infer<typeof RecoveryPreferences>;
export interface RecoveryPorts {
  preferences?(thread: ThreadId | undefined): Promise<RecoveryPreferences>;
  resetAt?(thread: ThreadId): number | null | undefined;
  /**
   * The account a usage-limit move goes to: `requested`, or another available account of the
   * thread's provider. Throws when there is none. The move itself is a thread transition.
   */
  moveTarget?(thread: ThreadId, requested?: string): string;
  contextWindow?: ContextWindowLookup;
  /** Reports a deadline pass that failed and will be retried. */
  onError?(error: unknown): void;
}
/** A deadline pass that could not commit (the store is busy, say) runs again after this. */
const deadlineRetryMs = 1_000;
/** Durable holds and one deadline timer, independent of actor/session residency. */
export class Recovery {
  private repo: EngineRepository;
  private clock: EngineClock;
  private ports: RecoveryPorts;
  private defaults: RecoveryPreferences;
  private wake: (id: ThreadId) => void;
  private cancel: (() => void) | undefined;
  private closed = false;
  private pendingPolicy = new Map<ThreadId, Promise<void>>();
  constructor(
    repo: EngineRepository,
    clock: EngineClock,
    ports: RecoveryPorts,
    defaults: RecoveryPreferences,
    wake: (id: ThreadId) => void,
  ) {
    this.repo = repo;
    this.clock = clock;
    this.ports = ports;
    this.defaults = defaults;
    this.wake = wake;
  }
  async prepare(id?: ThreadId): Promise<void> {
    const value = RecoveryPreferences.parse((await this.ports.preferences?.(id)) ?? this.defaults);
    await this.repo.store.writable();
    if (id)
      this.repo.store.atomic((db) =>
        db
          .prepare("UPDATE engine_queue SET preferences=? WHERE thread_id=?")
          .run(JSON.stringify(value), id),
      );
    else this.defaults = value;
  }
  preferences(id: ThreadId): RecoveryPreferences {
    const row = this.repo.store.atomic((db) =>
      db.prepare("SELECT preferences FROM engine_queue WHERE thread_id=?").get(id),
    );
    return row?.preferences
      ? RecoveryPreferences.parse(JSON.parse(String(row.preferences)))
      : this.defaults;
  }
  handle(command: Command): CommandResult | undefined {
    return handleQueue(command, {
      repo: this.repo,
      clock: this.clock,
      ports: this.ports,
      sync: (id) => this.sync(id),
      schedule: () => this.schedule(),
      wake: this.wake,
    });
  }
  admit(command: Command, id: ThreadId): Command | undefined {
    if (!isSend(command.payload)) return command;
    if (
      !this.repo.inputCapacity(id, maxMessages) ||
      Buffer.byteLength(JSON.stringify(command)) > maxMessageBytes
    )
      return undefined;
    const sent = this.withoutRestatedSelection(command, id);
    const p = sent.payload;
    // A steer that also changes the model or options is split by `admitSteer`.
    return p.type === "thread.send" && p.delivery === undefined
      ? Command.parse({
          ...sent,
          payload: { ...p, delivery: this.preferences(id).followUpBehavior },
        })
      : sent;
  }
  /**
   * Drops a send's model and options when they only repeat what the thread runs on, so it can
   * steer or start the next turn while background work runs. Kept when a queued switch or
   * selecting send would change what the thread runs on before this one is delivered.
   */
  private withoutRestatedSelection(command: Command, id: ThreadId): Command {
    const p = command.payload;
    if (
      p.type !== "thread.send" ||
      !restatesSelection(this.repo.transitions.get(id).selection, p) ||
      this.repo.transitions.guarded(id) ||
      this.repo.pending.selectionAhead(id)
    )
      return command;
    const { model: _model, options: _options, ...rest } = p;
    return Command.parse({ ...command, payload: rest });
  }
  sync(id: ThreadId): void {
    const queue = this.repo.queue.shown(id);
    const saved = this.repo.store.getThread(id)?.queue;
    if (!saved || saved.pendingCount !== queue.pendingCount || saved.revision !== queue.revision)
      this.repo.store.appendEvents(
        id,
        [
          {
            type: "queue.updated",
            paused: queue.paused,
            reason: queue.reason,
            resumeAt: queue.resumeAt,
            revision: queue.revision,
            pendingCount: queue.pendingCount,
          },
        ],
        this.clock.now(),
      );
    const fact = this.repo.engineQueueFact(id);
    if (fact) this.repo.apply(id, [fact], this.clock.now());
  }
  /** Permanent host subtree stop discards continuation and fences pending resumes.
   * Ordinary interruption/pause retains these records. */
  /** Cancelling a subtree discards resumable work but keeps a Stop's hold for the person. */
  discardKeepingStop(id: ThreadId): void {
    this.repo.store.atomic(() => {
      const queue = this.repo.queue.get(id);
      this.discard(id);
      if (queue.paused && queue.reason === "stopped")
        this.repo.queue.set(id, { paused: true, reason: "stopped" }, this.clock.now());
    });
  }
  /**
   * Builds before the Stop rule captured a restart "continue" behind a Stop, which left a
   * cancelled thread waiting on its queue forever. Startup drops it; the Stop's hold stays.
   */
  dropContinuationBehindStop(id: ThreadId): void {
    const queue = this.repo.queue.get(id);
    if (!stoppedHold(queue) || queue.trigger !== "restart") return;
    this.repo.queue.set(id, { continuation: null, trigger: null }, this.clock.now());
    this.sync(id);
  }
  discard(id: ThreadId): void {
    this.repo.store.atomic(() => {
      const queue = this.repo.queue.get(id);
      for (const intent of this.repo.pending.headers(id))
        if (
          ["thread.resume", "queue.resume", "thread.limit"].includes(intent.kind) &&
          ["pending", "queued", "running"].includes(intent.status)
        )
          this.repo.mark(intent, "failed", "Cancelled before delivery");
      this.repo.queue.set(
        id,
        {
          continuation: null,
          trigger: null,
          paused: false,
          reason: null,
          limited: false,
          resetAt: null,
          resumeAt: null,
          timerAction: null,
          holdToken: queue.holdToken + 1,
        },
        this.clock.now(),
      );
      this.sync(id);
    });
    this.schedule();
  }
  capture(id: ThreadId): void {
    if (this.repo.pending.uncertainContinuation(id)) return;
    // A Stop is final: the stopped turn never carries on, so a restart has nothing to resume.
    if (stoppedHold(this.repo.queue.get(id))) return;
    const text = lostWork(
      this.repo.requireState(id),
      this.repo.pending.recoveryAcknowledgement(id) ? 1 : 0,
      this.repo.backend(id),
      this.clock.now(),
    );
    if (!text) return;
    this.repo.queue.set(
      id,
      { continuation: continueMessage, trigger: "restart" },
      this.clock.now(),
    );
    this.sync(id);
  }
  /**
   * A provider that died with work in flight leaves its turn interrupted. The turn is held for
   * the person: Resume sends one continuation, and their next message carries on instead. ace
   * never continues it by itself.
   */
  holdInterrupted(id: ThreadId): void {
    if (this.repo.pending.uncertainContinuation(id)) return;
    const queue = this.repo.queue.get(id);
    if (stoppedHold(queue)) return;
    this.repo.queue.set(
      id,
      {
        continuation: queue.continuation ?? continueMessage,
        trigger: queue.trigger ?? "restart",
        paused: true,
        reason: queue.paused && queue.reason ? queue.reason : "restart",
        holdToken: queue.holdToken + 1,
      },
      this.clock.now(),
    );
    this.sync(id);
  }
  observe(state: ThreadState, facts: Fact[], _events: EventPayload[], at: number): void {
    if (
      !facts.some(
        (fact) =>
          (fact.type === "retry" && fact.on === "rate_limit") ||
          fact.type === "limit.cleared" ||
          (fact.type === "turn.ended" &&
            (fact.error?.kind === "quota" || fact.outcome === "completed")),
      )
    )
      return;
    const limited = Object.values(state.agents).filter((record) => record.limited);
    const queue = this.repo.queue.get(state.threadId);
    if (!limited.length) {
      if (!queue.limited) return;
      // The provider completed a turn: the account could work, so the limit hold goes. Other
      // clears (an explicit resume, a switch dropping the old account's facts) keep the hold
      // their owner manages.
      const completed = facts.some(
        (fact) => fact.type === "turn.ended" && fact.outcome === "completed" && !fact.historical,
      );
      if (
        completed &&
        queue.paused &&
        queue.reason === "limit" &&
        !this.repo.pending.recovering(state.threadId)
      )
        this.lift(state.threadId, at);
      else this.repo.queue.set(state.threadId, { limited: false }, at);
      return;
    }
    const accountReset = this.ports.resetAt?.(state.threadId);
    const reset =
      accountReset !== undefined
        ? accountReset
        : limited.every((record) => record.limited?.until !== undefined)
          ? Math.max(
              ...limited.flatMap((record) =>
                record.limited?.until === undefined ? [] : [record.limited.until],
              ),
            )
          : null;
    if (queue.limited && queue.resetAt === reset) return;
    const policy = this.ports.preferences ? "manual" : this.preferences(state.threadId).limitPolicy;
    // A limit with a known reset lets go at that reset. ace never starts a turn by itself:
    // only "resume at reset" sends then; otherwise the limit clears and queued messages wait
    // for the person's Resume or next message. Without a reset nothing is timed.
    const timed = policy !== "migrate_now";
    const action =
      policy === "resume_at_reset"
        ? "resume"
        : policy === "snooze_until_reset"
          ? "snooze"
          : "clear";
    this.repo.queue.set(
      state.threadId,
      {
        limited: true,
        paused: true,
        holdToken: queue.holdToken + 1,
        reason: "limit",
        resetAt: reset,
        continuation: queue.continuation ?? continueMessage,
        trigger: queue.trigger ?? "limit_resume",
        resumeAt: timed && reset !== null && reset > at ? reset : null,
        timerAction: timed && reset !== null && reset > at ? action : null,
      },
      at,
    );
    if (policy === "migrate_now" && this.ports.moveTarget)
      this.automatic(state.threadId, "migrate_now");
    this.schedule();
    if (this.ports.preferences)
      this.refreshPolicy(state.threadId, this.repo.queue.get(state.threadId).holdToken);
  }
  private refreshPolicy(id: ThreadId, token: number): void {
    if (this.pendingPolicy.has(id) || this.pendingPolicy.size >= 64 || this.closed) return;
    const task = this.prepare(id)
      .then(() => {
        const queue = this.repo.queue.get(id);
        if (this.closed || !queue.limited || !this.owns(id, token)) return;
        const policy = this.preferences(id).limitPolicy;
        if (policy === "migrate_now" && this.ports.moveTarget) this.automatic(id, "migrate_now");
        else if (
          (policy === "resume_at_reset" || policy === "snooze_until_reset") &&
          queue.resetAt !== null &&
          queue.resetAt > this.clock.now()
        )
          this.repo.queue.set(
            id,
            {
              resumeAt: queue.resetAt,
              timerAction: policy === "resume_at_reset" ? "resume" : "snooze",
              reason: policy === "resume_at_reset" ? "limit" : "snooze",
            },
            this.clock.now(),
          );
        this.schedule();
      })
      .catch(async (error: unknown) => {
        await this.repo.store.writable();
        if (!this.closed)
          this.repo.apply(
            id,
            [
              {
                type: "item.upsert",
                agent: "root",
                item: "recovery:settings",
                draft: {
                  type: "notice",
                  level: "error",
                  complete: true,
                  text: `Could not load recovery settings: ${error instanceof Error ? error.message : "Settings unavailable"}`,
                },
              },
            ],
            this.clock.now(),
          );
      })
      // The notice itself is a write; a store that refuses it is reported, never unhandled.
      .catch((error: unknown) => (this.ports.onError ?? console.error)(error))
      .finally(() => this.pendingPolicy.delete(id));
    this.pendingPolicy.set(id, task);
  }
  async flush(): Promise<void> {
    await Promise.all(this.pendingPolicy.values());
  }
  automatic(id: ThreadId, action?: "migrate_now"): CommandResult | undefined {
    const revision = this.repo.queue.get(id).revision;
    const p: CommandPayload = action
      ? { type: "thread.limit", threadId: id, expectedRevision: revision, action }
      : { type: "thread.resume", threadId: id, expectedRevision: revision };
    const command = Command.parse({
      id: this.repo.nextCommandId(),
      deviceId: "engine",
      payload: p,
    });
    const result = this.repo.store.recordCommand(
      command.id,
      command.deviceId,
      () =>
        this.handle(command) ?? {
          commandId: command.id,
          ok: false,
          error: "invalid_recovery_command",
        },
    );
    if (result.error === "engine_capacity_exceeded")
      this.repo.queue.set(
        id,
        { resumeAt: this.clock.now() + 1000, timerAction: action ? "migrate" : "resume" },
        this.clock.now(),
      );
    return result;
  }
  schedule(): void {
    this.cancel?.();
    this.cancel = undefined;
    if (this.closed) return;
    const at = this.repo.queue.nextDeadline();
    if (at === undefined) return;
    this.cancel = this.clock.setTimer(() => this.fire(), Math.max(0, at - this.clock.now()));
  }
  /** Timer callbacks must never throw: that would take the whole daemon down. */
  private fire(): void {
    try {
      if (this.repo.store.isHistoryWriting()) throw new Error("History publication in progress");
      this.repo.store.atomic(() => {
        for (const id of this.repo.queue.due(this.clock.now())) {
          const queue = this.repo.queue.get(id);
          if (queue.timerAction === "snooze")
            this.repo.queue.set(
              id,
              { resumeAt: null, timerAction: null, reason: "manual" },
              this.clock.now(),
            );
          else if (queue.timerAction === "clear") this.clearLimit(id);
          else {
            // Clear the deadline first, retaining a manual hold on capacity refusal.
            this.repo.queue.set(id, { resumeAt: null, timerAction: null }, this.clock.now());
            this.automatic(id, queue.timerAction === "migrate" ? "migrate_now" : undefined);
          }
        }
      });
      this.schedule();
    } catch (error) {
      // The pass rolled back, so its deadlines are still due; try them again shortly.
      try {
        (this.ports.onError ?? console.error)(error);
      } catch {
        /* Reporting cannot disable retries. */
      }
      this.cancel?.();
      this.cancel = this.closed
        ? undefined
        : this.clock.setTimer(() => this.fire(), deadlineRetryMs);
      return;
    }
  }
  moveTarget(id: ThreadId, requested?: string): string {
    if (!this.ports.moveTarget) throw new Error("Account migration is unavailable");
    return this.ports.moveTarget(id, requested);
  }
  /**
   * The thread moved to another account, model or provider. A limit or snooze hold it carried
   * becomes a cleared-limit hold (`clearLimit`'s marker): queued messages and the continuation
   * wait for Resume, and the person's next message goes at once on the new selection.
   */
  bindingChanged(id: ThreadId): void {
    const queue = this.repo.queue.get(id);
    const left = queue.paused && (queue.reason === "limit" || queue.reason === "snooze");
    const at = this.clock.now();
    this.repo.queue.set(
      id,
      {
        limited: false,
        resetAt: left ? at : null,
        resumeAt: null,
        timerAction: null,
        holdToken: queue.holdToken + 1,
        reason: left ? "manual" : queue.reason,
      },
      at,
    );
    this.schedule();
  }
  /**
   * The thread's account has a fresh reading below its limit: the limit no longer holds the
   * thread. ace starts no turn: queued messages wait for the person, except that a "resume at
   * reset" or snooze the person chose keeps its own deadline.
   */
  accountRecovered(id: ThreadId): void {
    const queue = this.repo.queue.get(id);
    if (!queue.limited || !queue.paused || queue.reason !== "limit") return;
    if (this.repo.pending.recovering(id)) return;
    this.clearLimit(id);
  }
  /**
   * The limit is gone (its reset passed, or a fresh reading has room): clear the limited state
   * so the thread and account read as available, keeping queued messages and the continuation
   * for the person's Resume or next message.
   */
  private clearLimit(id: ThreadId): void {
    const queue = this.repo.queue.get(id);
    const timed = queue.timerAction === "resume" || queue.timerAction === "snooze";
    const at = this.clock.now();
    this.repo.queue.set(
      id,
      timed
        ? { limited: false, resetAt: null }
        : // A manual hold that remembers when its limit cleared: the person's next message
          // releases it, unlike a pause they chose or a switch's held continuation.
          { limited: false, resetAt: at, reason: "manual", resumeAt: null, timerAction: null },
      at,
    );
    const state = this.repo.requireState(id);
    const cleared = Object.entries(state.agents)
      .filter(([, record]) => record.limited)
      .map(([agent]) => ({ type: "limit.cleared" as const, agent }));
    if (cleared.length) this.repo.apply(id, cleared, this.clock.now());
    this.sync(id);
    this.schedule();
  }
  /**
   * The person sends while a limit hold nothing definite keeps: a limit with no known reset, one
   * that has already cleared (or that a switch left behind), or one the thread is leaving (a
   * switch to another account, model or provider is ahead of the message). Their message
   * is the go-ahead: the hold and ace's own continuation are dropped and the queue sends in
   * order, with their message last, on the new selection when there is one. If the provider
   * refuses again, its definite signal holds the thread again. A known reset that hasn't passed
   * keeps holding otherwise, and so does a pause the person chose.
   */
  releaseLimitHold(id: ThreadId, at: number): void {
    const queue = this.repo.queue.get(id);
    if (!queue.paused) return;
    const leaving =
      (queue.reason === "limit" || queue.reason === "snooze") &&
      this.repo.pending.transition(id)?.kind === "thread.switch";
    const resetless = queue.limited && queue.reason === "limit" && queue.resetAt === null;
    // `clearLimit` leaves this marker: a manual hold that records when its limit cleared.
    const cleared = !queue.limited && queue.reason === "manual" && queue.resetAt !== null;
    if (!leaving && (queue.resumeAt !== null || (!resetless && !cleared))) return;
    if (this.repo.queue.hasUncertain(id) || this.repo.pending.recovering(id)) return;
    this.lift(id, at);
  }
  /** Lift a limit hold nothing holds any more, without sending a continuation. */
  private lift(id: ThreadId, at: number): void {
    const queue = this.repo.queue.get(id);
    this.repo.pending.finishContinuation(id);
    this.repo.queue.set(
      id,
      {
        limited: false,
        paused: false,
        reason: null,
        resetAt: null,
        resumeAt: null,
        timerAction: null,
        continuation: null,
        trigger: null,
        holdToken: queue.holdToken + 1,
      },
      at,
    );
    const state = this.repo.requireState(id);
    const cleared = Object.entries(state.agents)
      .filter(([, record]) => record.limited)
      .map(([agent]) => ({ type: "limit.cleared" as const, agent }));
    if (cleared.length) this.repo.apply(id, cleared, at);
    this.sync(id);
    this.schedule();
    queueMicrotask(() => this.wake(id));
  }
  owns(id: ThreadId, token: number): boolean {
    return this.repo.queue.get(id).holdToken === token;
  }
  begin(id: ThreadId, token: number): boolean {
    if (!this.owns(id, token)) return false;
    const state = this.repo.requireState(id);
    this.repo.apply(
      id,
      Object.entries(state.agents)
        .filter(([, record]) => record.limited)
        .map(([agent]) => ({ type: "limit.cleared", agent })),
      this.clock.now(),
    );
    return true;
  }
  release(id: ThreadId, token: number): void {
    if (!this.owns(id, token)) return;
    this.repo.queue.set(
      id,
      { limited: false, paused: false, reason: null, resumeAt: null, timerAction: null },
      this.clock.now(),
    );
  }
  close(): void {
    this.closed = true;
    this.cancel?.();
  }
}

function stoppedHold(queue: { paused: boolean; reason: string | null }): boolean {
  return queue.paused && queue.reason === "stopped";
}
