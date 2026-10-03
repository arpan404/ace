import { handleQueue } from "./queue-commands.ts";
import { lostWork } from "./lost-work.ts";
import { z } from "zod";
import {
  Command,
  type CommandResult,
  type ThreadId,
  type CommandPayload,
  type EventPayload,
} from "@ace/protocol";
import type { Fact, ThreadState } from "@ace/core";
import type { EngineRepository } from "./repository.ts";
import { maxMessageBytes, maxMessages, isSend } from "./queue-store.ts";
import type { EngineClock } from "./actor.ts";
import type { ContextWindowLookup } from "./context-meter.ts";

export const RecoveryPreferences = z.object({
  followUpBehavior: z.enum(["steer", "queue"]).default("queue"),
  continueAfterRestart: z.boolean().default(false),
  limitPolicy: z
    .enum(["manual", "resume_at_reset", "snooze_until_reset", "migrate_now"])
    .default("manual"),
});
export type RecoveryPreferences = z.infer<typeof RecoveryPreferences>;
export interface RecoveryPorts {
  preferences?(thread: ThreadId | undefined): Promise<RecoveryPreferences>;
  resetAt?(thread: ThreadId): number | null | undefined;
  migrate?(
    thread: ThreadId,
    target?: string,
  ): Promise<{ nativeSessionId: string; instanceId: string }>;
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
    repo.store.atomic((db) => {
      const columns = db.prepare("PRAGMA table_info(engine_queue)").all();
      if (!columns.some((column) => column.name === "preferences"))
        db.exec("ALTER TABLE engine_queue ADD COLUMN preferences JSON");
    });
  }
  async prepare(id?: ThreadId): Promise<void> {
    const value = RecoveryPreferences.parse((await this.ports.preferences?.(id)) ?? this.defaults);
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
      this.repo.queue.count(id) >= maxMessages ||
      Buffer.byteLength(JSON.stringify(command)) > maxMessageBytes
    )
      return undefined;
    const p = command.payload;
    return p.type === "thread.send" &&
      (p.delivery === undefined || p.model !== undefined || p.options !== undefined)
      ? Command.parse({
          ...command,
          payload: {
            ...p,
            // A selection belongs to the next turn, never a steer into the active run.
            delivery:
              p.model !== undefined || p.options !== undefined
                ? "queue"
                : this.preferences(id).followUpBehavior,
          },
        })
      : command;
  }
  sync(id: ThreadId): void {
    const count = this.repo.queuedCount(id);
    if (this.repo.requireState(id).queueSources.engine !== count)
      this.repo.apply(id, [{ type: "queue.changed", source: "engine", count }], this.clock.now());
  }
  /** Permanent host subtree stop discards continuation and fences pending resumes.
   * Ordinary interruption/pause retains these records. */
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
    const text = lostWork(
      this.repo.requireState(id),
      this.repo.pending.recoveryAcknowledgement(id) ? 1 : 0,
      this.repo.backend(id),
    );
    if (!text) return;
    this.repo.queue.set(id, { continuation: text, trigger: "restart" }, this.clock.now());
    this.sync(id);
    this.repo.apply(
      id,
      [
        {
          type: "item.upsert",
          agent: this.repo.requireState(id).rootKey ?? "root",
          item: `recovery:${this.repo.queue.get(id).revision}`,
          draft: { type: "notice", level: "warning", text, complete: true },
        },
      ],
      this.clock.now(),
    );
  }
  observe(state: ThreadState, facts: Fact[], _events: EventPayload[], at: number): void {
    if (
      !facts.some(
        (fact) =>
          (fact.type === "retry" && fact.on === "rate_limit") ||
          fact.type === "limit.cleared" ||
          (fact.type === "turn.ended" && fact.error?.kind === "quota"),
      )
    )
      return;
    const limited = Object.values(state.agents).filter((record) => record.limited);
    const queue = this.repo.queue.get(state.threadId);
    if (!limited.length) {
      if (queue.limited) this.repo.queue.set(state.threadId, { limited: false }, at);
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
    const timed = policy === "resume_at_reset" || policy === "snooze_until_reset";
    this.repo.queue.set(
      state.threadId,
      {
        limited: true,
        paused: true,
        holdToken: queue.holdToken + 1,
        reason: "limit",
        resetAt: reset,
        continuation:
          queue.continuation ??
          "ace is resuming after a provider usage limit. Continue the interrupted task from native history.",
        trigger: queue.trigger ?? "limit_resume",
        resumeAt: timed && reset !== null && reset > at ? reset : null,
        timerAction:
          timed && reset !== null && reset > at
            ? policy === "resume_at_reset"
              ? "resume"
              : "snooze"
            : null,
      },
      at,
    );
    if (policy === "migrate_now" && this.ports.migrate)
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
        if (policy === "migrate_now" && this.ports.migrate) this.automatic(id, "migrate_now");
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
      .catch((error: unknown) => {
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
      this.repo.store.atomic(() => {
        for (const id of this.repo.queue.due(this.clock.now())) {
          const queue = this.repo.queue.get(id);
          if (queue.timerAction === "snooze")
            this.repo.queue.set(
              id,
              { resumeAt: null, timerAction: null, reason: "manual" },
              this.clock.now(),
            );
          else {
            // Clear the deadline first, retaining a manual hold on capacity refusal.
            this.repo.queue.set(id, { resumeAt: null, timerAction: null }, this.clock.now());
            this.automatic(id, queue.timerAction === "migrate" ? "migrate_now" : undefined);
          }
        }
      });
    } catch (error) {
      // The pass rolled back, so its deadlines are still due; try them again shortly.
      (this.ports.onError ?? console.error)(error);
      this.cancel?.();
      this.cancel = this.closed
        ? undefined
        : this.clock.setTimer(() => this.fire(), deadlineRetryMs);
      return;
    }
    this.schedule();
  }
  async migrate(id: ThreadId, target?: string): Promise<void> {
    if (!this.ports.migrate) throw new Error("Account migration is unavailable");
    const result = await this.ports.migrate(id, target);
    this.repo.nativeSession(id, result.nativeSessionId, this.repo.backend(id), result.instanceId);
    const metadata = this.repo.transitions.get(id);
    if (metadata.selection) {
      metadata.selection.instanceId = result.instanceId;
      this.repo.transitions.set(id, metadata);
      this.repo.transitions.remember(id, metadata.selection);
      this.repo.store.appendEvents(
        id,
        [{ type: "thread.updated", execution: metadata.selection }],
        this.clock.now(),
      );
    }
  }
  bindingChanged(id: ThreadId): void {
    const queue = this.repo.queue.get(id);
    this.repo.queue.set(
      id,
      {
        limited: false,
        resetAt: null,
        resumeAt: null,
        timerAction: null,
        holdToken: queue.holdToken + 1,
        reason:
          queue.paused && (queue.reason === "limit" || queue.reason === "snooze")
            ? "manual"
            : queue.reason,
      },
      this.clock.now(),
    );
    this.schedule();
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
