import type { EngineRepository, Intent } from "./repository.ts";
import type { EngineClock } from "./actor.ts";
import type { Recovery } from "./recovery.ts";
import type { ThreadId } from "@ace/protocol";
/** Startup is a cold pass over stored thread headers and outstanding sends. */
export function recoverEngine(
  repo: EngineRepository,
  recovery: Recovery,
  clock: EngineClock,
  fail: (intent: Intent, message: string) => void,
  wake: (id: ThreadId) => void,
): void {
  repo.store.atomic(() => {
    for (const state of repo.states()) {
      const legacyLimits = Object.entries(state.agents).flatMap(([agent, record]) =>
        record.retry?.on === "rate_limit" && !record.limited
          ? [{ type: "retry" as const, agent, ...record.retry }]
          : [],
      );
      if (legacyLimits.length) repo.apply(state.threadId, legacyLimits, clock.now());
      const untracked = state.queueSources.engine > repo.queuedCount(state.threadId);
      if (untracked || state.queueSources.provider > 0)
        repo.apply(
          state.threadId,
          [
            {
              type: "item.upsert",
              agent: state.rootKey ?? "root",
              item: "recovery:untracked",
              draft: {
                type: "notice",
                level: "warning",
                text: untracked
                  ? "Recovered untracked queue state; execution is uncertain"
                  : "Provider queued work was interrupted; execution is uncertain",
                complete: true,
              },
            },
          ],
          clock.now(),
        );
      recovery.capture(state.threadId);
      const live =
        !state.processExit &&
        (state.queueSources.provider > 0 ||
          Object.values(state.agents).some(
            (record) =>
              record.activeRun ||
              record.wakeUntil !== undefined ||
              !["idle", "failed", "interrupted"].includes(record.agent.status.state),
          ) ||
          Object.keys(state.indexes.pendingInteractions).length ||
          Object.keys(state.indexes.runningTasks).length);
      if (live)
        repo.apply(
          state.threadId,
          [
            {
              type: "process.exited",
              deliberate: false,
              message: "Daemon restarted; previous provider work stopped",
            },
            { type: "queue.changed", source: "provider", count: 0 },
          ],
          clock.now(),
        );
    }
    for (const intent of repo.intents()) {
      if (intent.status === "running" || intent.awaiting) {
        if (
          intent.command.payload.type === "thread.send" ||
          intent.command.payload.type === "thread.create"
        )
          repo.queue.uncertain(intent.id);
        fail(
          intent,
          "Delivery interrupted by daemon restart; execution is uncertain. Review before resending.",
        );
      } else if (
        intent.status === "pending" &&
        !["thread.send", "thread.create", "thread.resume", "queue.resume", "thread.limit"].includes(
          intent.command.payload.type,
        )
      )
        fail(intent, "Control interrupted by daemon restart; retry explicitly");
    }
    for (const state of repo.states()) {
      const queue = repo.queue.get(state.threadId);
      const pending = repo
        .intents(state.threadId)
        .some((intent) => ["pending", "queued"].includes(intent.status));
      recovery.sync(state.threadId);
      if (!pending && !queue.continuation && !repo.queue.count(state.threadId)) continue;
      const uncertain = repo.queue.hasUncertain(state.threadId);
      repo.queue.set(
        state.threadId,
        { paused: true, reason: uncertain ? "uncertain" : queue.limited ? "limit" : "restart" },
        clock.now(),
      );
      recovery.sync(state.threadId);
      if (!uncertain && !queue.limited && recovery.preferences(state.threadId).continueAfterRestart)
        recovery.automatic(state.threadId);
      // Recovery controls already accepted before a crash are safe only when unclaimed.
      if (
        repo
          .intents(state.threadId)
          .some(
            (intent) =>
              intent.status === "pending" &&
              ["thread.resume", "queue.resume", "thread.limit"].includes(
                intent.command.payload.type,
              ),
          ) &&
        repo.reserve(state.threadId)
      )
        wake(state.threadId);
    }
  });
  recovery.schedule();
}
