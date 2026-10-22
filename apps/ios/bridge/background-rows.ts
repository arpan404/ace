import type { ThreadSource } from "@ace/client";
import { backgroundCommand, backgroundTaskLine, ledgerOf } from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * Commands a work log's calls left running in the background, each as its own line where it
 * started: "Running in background `bun run dev:relay` 3m", updating in place as the task ends
 * (the web's `BackgroundTaskLine`). ace's own bookkeeping is never listed. Pure over the store.
 */

export function backgroundRows(store: ThreadSource, ids: readonly string[]) {
  const calls = ledgerOf(store).background;
  if (!calls.size) return [];
  return ids.flatMap((id) => {
    const taskId = calls.get(id);
    const task = taskId === undefined ? undefined : store.task(taskId);
    if (!task || task.internal) return [];
    return [
      {
        itemId: id,
        taskId: task.id,
        /** "Running in background", "Finished", "Stopped". */
        label: backgroundTaskLine(task.status),
        command: preview(backgroundCommand(task, store.item(id)), 512),
        running: task.status === "running",
        status: task.status,
        stoppable: task.stoppable,
        startedAt: task.startedAt,
        endedAt: task.endedAt ?? null,
      },
    ];
  });
}
