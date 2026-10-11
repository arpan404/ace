import { unexpectedStopNotice } from "./thread-liveness.ts";
import type { EngineRepository, IntentHeader } from "./repository.ts";
import type { EngineClock } from "./actor.ts";
import type { Recovery } from "./recovery.ts";
import type { ThreadId } from "@ace/protocol";
import { lostWork } from "./lost-work.ts";
/** Startup is a cold pass over stored thread headers and outstanding sends. */
export function recoverEngine(
  repo: EngineRepository,
  recovery: Recovery,
  clock: EngineClock,
  fail: (intent: IntentHeader, message: string) => void,
  wake: (id: ThreadId) => void,
): void {
  repo.store.atomic(() => {
    repo.transitions.pruneGuards();
    repo.clearIncompleteBlobs();
  });
  for (const state of repo.recoveryStates()) {
    repo.store.atomic(() => {
      if (repo.cleaning(state.threadId)) return;
      const removedGates = Object.entries(state.interactions).flatMap(([key, interaction]) =>
        interaction.state === "pending" &&
        interaction.raw.some((raw) => raw.type === "ace.conductor.gate")
          ? [{ type: "interaction.closed" as const, interaction: key, state: "cancelled" as const }]
          : [],
      );
      if (removedGates.length) repo.apply(state.threadId, removedGates, clock.now());
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
      const unsent = repo.pending.undelivered(state.threadId);
      if (unsent) {
        repo.pending.defer(unsent);
        repo.queue.track(unsent.id, state.threadId, unsent.command);
        repo.admitInput(unsent.command, state.threadId, clock.now());
        repo.queue.set(state.threadId, { paused: true, reason: "not_sent" }, clock.now());
      }
      const queue = repo.queue.get(state.threadId);
      if (
        (queue.trigger === "restart" || queue.reason === "restart") &&
        !Object.keys(state.runs).length
      )
        repo.queue.set(
          state.threadId,
          {
            continuation: null,
            trigger: null,
            paused: repo.queue.count(state.threadId) > 0,
            reason: repo.queue.count(state.threadId) ? "not_sent" : null,
          },
          clock.now(),
        );
      recovery.capture(state.threadId);
      // A stopped provider no longer owns an admitted continuation. Native history
      // remains the source for a new restart continuation, never the old input.
      repo.pending.finishContinuation(state.threadId);
      const backend = repo.backend(state.threadId);
      const interrupted = lostWork(state, 0, backend);
      const live = !state.processExit && interrupted !== undefined;
      if (live && backend === "cursor-sdk")
        repo.apply(
          state.threadId,
          [
            {
              type: "item.upsert",
              agent: state.rootKey ?? "root",
              item: "recovery:uncertain",
              draft: {
                type: "notice",
                level: "warning",
                code: "recovery_uncertain",
                title: "Recovery needed",
                text: "Previous work needs reconciliation",
                detail: interrupted,
                complete: true,
              },
            },
          ],
          clock.now(),
        );
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
            unexpectedStopNotice(state.rootKey, clock.now()),
          ],
          clock.now(),
        );
    });
  }
  for (const intent of repo.pending.headers()) {
    repo.store.atomic(() => {
      if (repo.cleaning(intent.threadId)) {
        fail(intent, "Retired for thread deletion");
        return;
      }
      if (repo.store.getThread(intent.threadId)?.continuation) {
        fail(
          intent,
          "This Cursor CLI thread is read-only. Continue in a new thread with its saved history.",
        );
        return;
      }
      if (intent.status === "running" || intent.awaiting) {
        if (
          ["thread.send", "thread.create", "thread.fork"].includes(intent.kind) &&
          intent.submittedGeneration === undefined &&
          !intent.acknowledged
        ) {
          repo.pending.defer(intent);
          return;
        }
        if (
          !intent.acknowledged &&
          (intent.kind === "thread.send" || intent.kind === "thread.create")
        )
          repo.queue.uncertain(intent.id);
        fail(
          intent,
          "Delivery interrupted by daemon restart; execution is uncertain. Review before resending.",
        );
      } else if (
        intent.status === "pending" &&
        ![
          "thread.send",
          "thread.create",
          "thread.fork",
          "thread.switch",
          "thread.merge",
          "thread.resume",
          "queue.resume",
          "thread.limit",
        ].includes(intent.kind)
      )
        fail(intent, "Control interrupted by daemon restart; retry explicitly");
    });
  }
  for (const state of repo.recoveryStates()) {
    repo.store.atomic(() => {
      if (repo.cleaning(state.threadId)) return;
      const queue = repo.queue.get(state.threadId);
      const pending = Boolean(
        repo.pending.message(state.threadId) || repo.pending.recovery(state.threadId),
      );
      recovery.sync(state.threadId);
      if (!pending && !queue.continuation && !repo.queue.count(state.threadId)) return;
      const uncertain = repo.queue.hasUncertain(state.threadId);
      repo.queue.set(
        state.threadId,
        {
          paused: true,
          reason: ["stopped", "model_unavailable", "not_sent"].includes(queue.reason ?? "")
            ? queue.reason
            : uncertain
              ? "uncertain"
              : queue.limited
                ? "limit"
                : queue.continuation
                  ? "restart"
                  : "not_sent",
        },
        clock.now(),
      );
      recovery.sync(state.threadId);
      if (
        !uncertain &&
        !queue.limited &&
        !["stopped", "model_unavailable", "not_sent"].includes(queue.reason ?? "") &&
        recovery.preferences(state.threadId).continueAfterRestart
      )
        recovery.automatic(state.threadId);
      // Recovery controls already accepted before a crash are safe only when unclaimed.
      if (
        (repo.pending.recovery(state.threadId) || repo.pending.transition(state.threadId)) &&
        repo.reserve(state.threadId)
      )
        wake(state.threadId);
    });
  }
  recovery.schedule();
}
