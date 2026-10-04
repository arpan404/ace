import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { useState } from "react";
import { blockItems, buildBlocks, blocksEqual, type Block } from "./blocks.ts";

/** The thread's blocks, or with `agentId` only that agent's own items as blocks. */
function readBlocks(reader: ThreadReader, agentId?: string): Block[] {
  const background = new Map<string, string>();
  for (const taskId of reader.taskIds()) {
    const task = reader.task(taskId);
    if (task?.toolCallId && !task.ambient) background.set(task.toolCallId, taskId);
  }
  const order =
    agentId === undefined
      ? reader.order
      : reader.order.filter((id) => reader.item(id)?.agentId === agentId);
  return buildBlocks({ order, item: (id) => reader.item(id), background });
}

/** Keep each unchanged block's object, so memoized rows skip re-rendering. */
function reuse(previous: readonly Block[], next: Block[]): Block[] {
  const byKey = new Map(previous.map((block) => [block.key, block]));
  return next.map((block) => {
    const old = byKey.get(block.key);
    if (!old || old.kind !== block.kind) return block;
    const a = blockItems(old);
    const b = blockItems(block);
    return a.length === b.length && a.every((id, index) => id === b[index]) ? old : block;
  });
}

const none: readonly Block[] = [];

/** A selector that remembers its last result, so unchanged blocks keep their objects. */
function createBlockReader(agentId?: string): (reader: ThreadReader) => readonly Block[] {
  let last: readonly Block[] = none;
  return (reader) => {
    last = reuse(last, readBlocks(reader, agentId));
    return last;
  };
}

/**
 * Transcript blocks. Re-derived only when items are added or background tasks start, never on
 * a streamed delta; the list and each unchanged block keep their identity. The thread screen
 * remounts per thread, so one reader serves one thread.
 */
export function useBlocks(threadId: string): readonly Block[] {
  const [read] = useState(() => createBlockReader());
  return useThread(threadId, ["order", "tasks"], read, blocksEqual) ?? none;
}

/** One agent's own blocks in the loaded window (a subagent's work, without its parent's). */
export function useAgentBlocks(threadId: string, agentId: string): readonly Block[] {
  const [read] = useState(() => createBlockReader(agentId));
  return useThread(threadId, ["order", "tasks"], read, blocksEqual) ?? none;
}
