import { Command, type CommandResult, type ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { EngineClock } from "./actor.ts";
import { maxMessageBytes } from "./queue-store.ts";
interface Dependencies {
  repo: EngineRepository;
  clock: EngineClock;
  ports: { resetAt?(thread: ThreadId): number | null | undefined; migrate?: unknown };
  sync(id: ThreadId): void;
  schedule(): void;
  wake(id: ThreadId): void;
}
/** Receipts and compare-and-swap edits share the engine transaction. */
export function handleQueue(
  command: Command,
  dependencies: Dependencies,
): CommandResult | undefined {
  const p = command.payload;
  if (!p.type.startsWith("queue.") && p.type !== "thread.resume" && p.type !== "thread.limit")
    return undefined;
  const fail = (error: string): CommandResult => ({ commandId: command.id, ok: false, error });
  if (!("threadId" in p) || !("expectedRevision" in p)) return fail("invalid_queue_command");
  return dependencies.repo.store.atomic(() => {
    const state = dependencies.repo.state(p.threadId);
    if (!state) return fail("thread_not_found");
    const queue = dependencies.repo.queue.get(p.threadId);
    if (p.expectedRevision !== queue.revision) return fail("queue_conflict");
    const entry =
      "messageId" in p ? dependencies.repo.queue.editable(p.threadId, p.messageId) : undefined;
    if ("messageId" in p && !entry) return fail("message_already_claimed");
    if (p.type === "queue.edit" && entry) {
      if (entry.uncertain) return fail("uncertain_delivery");
      if (Buffer.byteLength(JSON.stringify(p)) > maxMessageBytes) return fail("message_too_large");
      const old = entry.command.payload;
      if (old.type !== "thread.send" && old.type !== "thread.create")
        return fail("invalid_queue_entry");
      const { context: _context, ...rest } = old;
      const payload = {
        ...rest,
        input: p.input,
        ...(p.context ? { context: p.context } : {}),
        ...(old.type === "thread.send" && p.delivery ? { delivery: p.delivery } : {}),
      };
      const edited = Command.parse({ ...entry.command, payload });
      dependencies.repo.queue.edit(entry.id, edited);
      dependencies.repo.admitInput(edited, p.threadId, dependencies.clock.now());
    } else if (p.type === "queue.remove" && entry) {
      dependencies.repo.queue.remove(entry.id);
      dependencies.repo.removeInput(p.threadId, entry.command.id, dependencies.clock.now());
    } else if (p.type === "queue.resend" && entry) {
      if (!entry.uncertain) return fail("message_not_uncertain");
      const old = entry.command.payload;
      if (old.type !== "thread.create" && old.type !== "thread.send")
        return fail("invalid_queue_entry");
      const replacement = Command.parse({
        ...command,
        payload: {
          type: "thread.send",
          threadId: p.threadId,
          input: old.input,
          context: old.context,
          origin: old.origin,
          trigger: old.trigger,
          delivery: old.type === "thread.send" ? old.delivery : "queue",
        },
      });
      dependencies.repo.queue.remove(entry.id);
      dependencies.repo.removeInput(p.threadId, entry.command.id, dependencies.clock.now());
      dependencies.repo.add(replacement, p.threadId);
      dependencies.repo.admitInput(replacement, p.threadId, dependencies.clock.now());
      // Only the ambiguity hold may be released, never a later pause or recovery hold.
      if (
        queue.reason === "uncertain" &&
        !dependencies.repo.queue.hasUncertain(p.threadId) &&
        !queue.limited &&
        !queue.continuation
      )
        dependencies.repo.queue.set(
          p.threadId,
          { paused: false, reason: null },
          dependencies.clock.now(),
        );
    } else if (p.type === "queue.move" && entry) {
      if (dependencies.repo.queue.hasUncertain(p.threadId)) return fail("uncertain_delivery");
      const after =
        p.after === null ? null : dependencies.repo.queue.editable(p.threadId, p.after)?.id;
      if (after === undefined || !dependencies.repo.queue.move(p.threadId, entry.id, after))
        return fail("invalid_queue_position");
    } else if (p.type === "queue.pause") {
      for (const intent of dependencies.repo.pending.headers(p.threadId))
        if (
          intent.status === "pending" &&
          ["thread.resume", "queue.resume", "thread.limit"].includes(intent.kind)
        )
          dependencies.repo.mark(intent, "failed", "Cancelled by queue pause");
      dependencies.repo.queue.set(
        p.threadId,
        {
          paused: true,
          reason: "manual",
          resumeAt: null,
          timerAction: null,
          holdToken: queue.holdToken + 1,
        },
        dependencies.clock.now(),
      );
      dependencies.schedule();
      queueMicrotask(() => dependencies.wake(p.threadId));
      return { commandId: command.id, ok: true };
    } else if (
      p.type === "thread.limit" ||
      p.type === "thread.resume" ||
      p.type === "queue.resume"
    ) {
      if (
        p.type === "thread.limit" &&
        p.action === "migrate_now" &&
        dependencies.repo.backend(p.threadId) === "cursor-sdk"
      )
        return fail("sdk_account_migration_unsupported");
      if (p.type === "thread.limit" && p.action === "migrate_now" && !dependencies.ports.migrate)
        return fail("migration_unavailable");
      if (
        p.type === "thread.limit" &&
        ["resume_at_reset", "snooze_until_reset"].includes(p.action)
      ) {
        const accountReset = dependencies.ports.resetAt?.(p.threadId);
        const reset = accountReset === undefined ? queue.resetAt : accountReset;
        if (reset === null || reset === undefined || reset <= dependencies.clock.now())
          return fail("reset_time_unknown");
        dependencies.repo.queue.set(
          p.threadId,
          {
            paused: true,
            holdToken: queue.holdToken + 1,
            reason: p.action === "resume_at_reset" ? "limit" : "snooze",
            resumeAt: reset,
            timerAction: p.action === "resume_at_reset" ? "resume" : "snooze",
          },
          dependencies.clock.now(),
        );
        dependencies.schedule();
        return { commandId: command.id, ok: true };
      }
      if (dependencies.repo.pending.recovering(p.threadId)) return fail("recovery_in_progress");
      if (dependencies.repo.queue.hasUncertain(p.threadId)) return fail("uncertain_delivery");
      if (!dependencies.repo.reserve(p.threadId)) return fail("engine_capacity_exceeded");
      dependencies.repo.add(command, p.threadId);
      // Hold sends while a resume/migration is in flight, even if the source exits.
      dependencies.repo.queue.set(
        p.threadId,
        {
          paused: true,
          holdToken: queue.holdToken + 1,
          reason: queue.reason ?? "manual",
          resumeAt: null,
          timerAction: null,
        },
        dependencies.clock.now(),
      );
      queueMicrotask(() => dependencies.wake(p.threadId));
      dependencies.schedule();
      return { commandId: command.id, ok: true };
    } else return fail("invalid_queue_command");
    dependencies.repo.queue.reconcileUncertainty(p.threadId, dependencies.clock.now());
    dependencies.sync(p.threadId);
    if (
      dependencies.repo.reservedSlot(p.threadId) ||
      (!dependencies.repo.queue.get(p.threadId).paused && dependencies.repo.reserve(p.threadId))
    )
      queueMicrotask(() => dependencies.wake(p.threadId));
    return { commandId: command.id, ok: true };
  });
}
