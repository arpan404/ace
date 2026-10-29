import type { ThreadKey, ThreadReader } from "@ace/client";
import { mergeReceipts } from "@ace/ui-core";
import { useThreadMeta } from "@ace/client-react";
import { useMemo, useState } from "react";
import { useServerQueue } from "@/lib/server-queue.ts";
import { blocksEqual, withoutQueued, type Block } from "./blocks.ts";
import { useWatched } from "@/lib/use-watched.ts";
import { createBlockReader } from "./block-reader.ts";

const none: readonly Block[] = [];

/** What blocks are built from: items, background tasks, interactions and how turns end. */
function useBlockKeys(threadId: string, agentId?: string): readonly ThreadKey[] {
  const owner = useThreadMeta(threadId)?.rootAgentId;
  const agent = agentId ?? owner ?? "";
  return useMemo(
    () => ["order", "tasks", "interactions", "agents", "thread", "queue", `agent:${agent}`],
    [agent],
  );
}

/**
 * Transcript blocks. Re-derived only when items are added, background tasks start, inline
 * questions open, or a turn's runs and spawned agents settle (each watched by its own key),
 * never on a streamed delta; the list and each unchanged block keep their identity. The thread
 * screen remounts per thread, so one reader serves one thread.
 */
export function useBlocks(threadId: string): readonly Block[] {
  const [read] = useState(() => {
    const blocks = createBlockReader();
    // Back-to-back receipts of delegated work read as one row.
    return (reader: ThreadReader) => {
      const built = blocks(reader);
      return { ...built, value: mergeReceipts(built.value, (id) => reader.item(id)) };
    };
  });
  const blocks = useWatched(threadId, useBlockKeys(threadId), read, blocksEqual) ?? none;
  const queued = useServerQueue(threadId).page?.messages;
  return useMemo(() => withoutQueued(blocks, queued), [blocks, queued]);
}

/** One agent's own blocks in the loaded window (a subagent's work, without its parent's). */
export function useAgentBlocks(threadId: string, agentId: string): readonly Block[] {
  const [read] = useState(() => createBlockReader(agentId));
  return useWatched(threadId, useBlockKeys(threadId, agentId), read, blocksEqual) ?? none;
}
