import { useThread } from "@ace/client-react";
import type { ThreadReader } from "@ace/client";
import { buildBlocks, blocksEqual, type Block } from "./blocks.ts";

function readBlocks(reader: ThreadReader): Block[] {
  const background = new Map<string, string>();
  for (const taskId of reader.taskIds()) {
    const task = reader.task(taskId);
    if (task?.toolCallId && !task.ambient) background.set(task.toolCallId, taskId);
  }
  return buildBlocks({ order: reader.order, item: (id) => reader.item(id), background });
}

const none: readonly Block[] = [];

/**
 * Transcript blocks. Re-derived only when items are added or background tasks start, never on
 * a streamed delta, and the list keeps its identity unless its shape changed.
 */
export function useBlocks(threadId: string): readonly Block[] {
  return useThread(threadId, ["order", "tasks"], readBlocks, blocksEqual) ?? none;
}
