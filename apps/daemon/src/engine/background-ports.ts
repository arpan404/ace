import { ownerTurnFinished } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { PortCandidate } from "../background-services/task-ports.ts";
import type { EngineRepository } from "./repository.ts";

/** What the background command port probe reads from and reports into a thread (ADR 0109). */
export interface BackgroundPortsHost {
  /** Its running background commands the probe can look at: shells with an output file. */
  candidates(threadId: ThreadId): PortCandidate[];
  /** The ports a command listens on now; empty when none. */
  report(threadId: ThreadId, taskId: string, ports: number[]): void;
}

export function backgroundPortsHost(
  repo: EngineRepository,
  now: () => number,
  applied: (threadId: ThreadId) => void,
): BackgroundPortsHost {
  return {
    candidates(threadId) {
      const state = repo.state(threadId);
      if (!state) return [];
      return Object.keys(state.indexes.runningTasks).flatMap((key) => {
        const task = state.tasks[key];
        // A provider that never wakes the agent already released it: nothing to learn.
        if (
          task?.status !== "running" ||
          task.ambient ||
          task.kind !== "shell" ||
          task.wakesAgent === false ||
          task.outputPath === undefined
        )
          return [];
        return [
          {
            taskId: task.id,
            outputPath: task.outputPath,
            turnFinished: ownerTurnFinished(state, task),
            listening: task.listening ?? [],
          },
        ];
      });
    },
    report(threadId, taskId, ports) {
      const task = repo.nativeEntity(threadId, "tasks", taskId);
      if (task === undefined) return;
      repo.apply(threadId, [{ type: "background.listening", task, ports }], now());
      applied(threadId);
    },
  };
}
