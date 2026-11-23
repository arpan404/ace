import type { ThreadSource } from "@ace/client";
import {
  backgroundCommand,
  commandLabel,
  backgroundTaskLine,
  ledgerOf,
  turnTreeOf,
} from "@ace/ui-core";
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
    const item = store.item(id);
    const command = backgroundCommand(task, item);
    const detail = item?.type === "tool_call" ? item.call.detail : undefined;
    return [
      {
        itemId: id,
        taskId: task.id,
        /** "Running in background", "Finished", "Stopped". */
        label: backgroundTaskLine(task.status),
        command: preview(command, 8192),
        /** What it does in words: the provider's description, else the command's summary. */
        description: preview(
          commandLabel({
            command,
            description: detail?.kind === "shell" ? detail.description : undefined,
          }),
          256,
        ),
        running: task.status === "running",
        /**
         * Settled, or a running command the thread's live tree counts (the pill's "1 command",
         * whose Agents sheet stops it). A running task it doesn't count (a monitor) shows only
         * on this line, so the phone keeps it.
         */
        counted: task.status !== "running" || turnTreeOf(store).countsTask(task.id),
        status: task.status,
        stoppable: task.stoppable,
        startedAt: task.startedAt,
        endedAt: task.endedAt ?? null,
      },
    ];
  });
}
