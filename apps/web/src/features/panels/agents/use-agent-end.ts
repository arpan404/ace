import type { ThreadReader } from "@ace/client";
import { useThreadMeta } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { useCallback } from "react";
import { useWatched } from "@/lib/use-watched.ts";

const keys = ["order"] as const;

/** Providers can finish a run without ending the reusable agent entity. */
export function useAgentEnd(threadId: string, agent: Agent): number | undefined {
  const scope = agent.childThreadId ?? threadId;
  const child = useThreadMeta(agent.childThreadId);
  const id = agent.childThreadId ? child?.rootAgentId : agent.id;
  const read = useCallback(
    (reader: ThreadReader) => {
      let end: number | undefined;
      const runs = new Set<string>();
      for (const itemId of reader.order) {
        const item = reader.item(itemId);
        if (!item || item.agentId !== id || !item.runId || runs.has(item.runId)) continue;
        runs.add(item.runId);
        const ended = reader.run(item.runId)?.endedAt;
        if (ended !== undefined) end = Math.max(end ?? ended, ended);
      }
      return { value: end, watch: [...runs].map((run) => `run:${run}`) };
    },
    [id],
  );
  const end = useWatched(scope, keys, read, Object.is);
  return agent.endedAt ?? end;
}
