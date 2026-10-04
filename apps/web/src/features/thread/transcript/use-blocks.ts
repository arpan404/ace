import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import { rootRunOf } from "@ace/ui-core";
import { useMemo, useState } from "react";
import { buildBlocks, blocksEqual, isInlineInteraction, sameBlock, type Block } from "./blocks.ts";

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
  const questions = reader.interactionIds().flatMap((id) => {
    const interaction = reader.interaction(id);
    if (!interaction || !isInlineInteraction(interaction)) return [];
    if (agentId !== undefined && interaction.agentId !== agentId) return [];
    return [interaction];
  });
  // Turns are the root agent's runs (a subagent's work counts toward the turn that spawned it);
  // one agent's own transcript turns on its own runs.
  const owner = agentId ?? reader.thread?.rootAgentId;
  const state = owner ? reader.agent(owner)?.status.state : undefined;
  return buildBlocks({
    order,
    item: (id) => reader.item(id),
    background,
    questions,
    turnOf: (id) => {
      const runId = reader.item(id)?.runId;
      return agentId === undefined ? rootRunOf(reader, runId)?.id : runId;
    },
    turnEnded: (runId) => {
      const run = reader.run(runId);
      return run && run.state !== "active" ? run.state : undefined;
    },
    reviewedCall: (interactionId) => reader.interaction(interactionId)?.toolCallId,
    stoppedTail: state === "failed" || state === "interrupted",
  });
}

/** Keep each unchanged block's object, so memoized rows skip re-rendering. */
function reuse(previous: readonly Block[], next: Block[]): Block[] {
  const byKey = new Map(previous.map((block) => [block.key, block]));
  return next.map((block) => {
    const old = byKey.get(block.key);
    return old && sameBlock(old, block) ? old : block;
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

/** What blocks are built from: items, background tasks, interactions and how turns end. */
function useBlockKeys(threadId: string, agentId?: string): readonly ThreadKey[] {
  const owner = useThreadMeta(threadId)?.rootAgentId;
  const agent = agentId ?? owner ?? "";
  return useMemo(
    () => ["order", "tasks", "interactions", "agents", "thread", `agent:${agent}`],
    [agent],
  );
}

/**
 * Transcript blocks. Re-derived only when items are added, background tasks start,
 * interactions open or close or the agent's turn ends, never on a streamed delta; the list and each unchanged block keep their identity. The thread screen
 * remounts per thread, so one reader serves one thread.
 */
export function useBlocks(threadId: string): readonly Block[] {
  const [read] = useState(() => createBlockReader());
  return useThread(threadId, useBlockKeys(threadId), read, blocksEqual) ?? none;
}

/** One agent's own blocks in the loaded window (a subagent's work, without its parent's). */
export function useAgentBlocks(threadId: string, agentId: string): readonly Block[] {
  const [read] = useState(() => createBlockReader(agentId));
  return useThread(threadId, useBlockKeys(threadId, agentId), read, blocksEqual) ?? none;
}
