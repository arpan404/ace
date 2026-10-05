import type { ThreadId, EventPayload } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

export function cancelPending(repo: EngineRepository, id: ThreadId, now: number): ThreadId[] {
  return repo.store.atomic((_db) => {
    const released = new Set<ThreadId>();
    for (const intent of repo.pending.headers(id)) {
      if (!["pending", "queued"].includes(intent.status)) continue;
      const kind = intent.kind;
      if (kind !== "thread.switch" && kind !== "thread.merge") continue;
      repo.mark(intent, "failed", "Cancelled before delivery");
      for (const thread of repo.transitions.releaseGuards(intent.commandId)) released.add(thread);
      if (kind === "thread.switch") {
        const pending = repo.store.getThread(id)?.switch;
        if (pending)
          repo.store.appendEvents(
            id,
            [
              {
                type: "thread.updated",
                switch: {
                  ...pending,
                  state: "failed",
                  error: "Cancelled before delivery",
                  at: now,
                },
              },
            ],
            now,
          );
      }
    }
    // Fork intents belong to their new thread, never to the lineage source.
    for (const intent of repo.pending.headers(id)) {
      if (intent.kind !== "thread.fork" || intent.status === "running") continue;
      for (const thread of repo.transitions.releaseGuards(intent.commandId)) released.add(thread);
    }
    const stoppedInputs: EventPayload[] = [];
    const state = repo.requireState(id);
    const activeRuns = new Set(
      Object.values(state.agents).flatMap((record) => (record.activeRun ? [record.activeRun] : [])),
    );
    for (const key of repo.inputs.inRuns(id, activeRuns)) {
      const item = state.items[key];
      if (
        item?.type === "message" &&
        item.role === "user" &&
        item.runId &&
        activeRuns.has(item.runId)
      ) {
        const updated = { ...item, notAnswered: "stopped" as const };
        state.items[key] = updated;
        stoppedInputs.push({ type: "item.updated", item: updated });
      }
    }
    for (const intent of repo.pending.headers(id)) {
      if (intent.status !== "running" && !intent.awaiting) continue;
      if (!["thread.send", "thread.create", "thread.fork"].includes(intent.kind)) continue;
      if (intent.submittedGeneration === undefined && !intent.acknowledged) {
        repo.pending.defer(intent);
        continue;
      }
      const key = `input:${intent.commandId}`;
      const item = state.items[key];
      if (item?.type === "message" && !item.notAnswered) {
        const updated = { ...item, notAnswered: "stopped" as const };
        state.items[key] = updated;
        stoppedInputs.push({ type: "item.updated", item: updated });
      }
      repo.mark(intent, "failed", "Cancelled before delivery");
    }
    if (stoppedInputs.length) repo.save(state, stoppedInputs, now);
    repo.queue.set(id, {}, now);
    return [...released];
  });
}

/** Cancelling a delegated task retires its work; ordinary Stop retains the queue. */
export function cancelDelegatedInputs(repo: EngineRepository, id: ThreadId, now: number): void {
  repo.store.atomic(() => {
    repo.cancelPending(id, now);
    for (const intent of repo.pending.headers(id)) {
      if (
        !["thread.send", "thread.create", "thread.fork"].includes(intent.kind) ||
        (!["pending", "queued", "running"].includes(intent.status) && !intent.awaiting)
      )
        continue;
      repo.mark(intent, "failed", "Cancelled before delivery");
      repo.queue.prune(intent.id);
    }
    repo.queue.set(id, {}, now);
  });
}
