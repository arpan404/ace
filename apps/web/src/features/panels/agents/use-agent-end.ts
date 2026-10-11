import type { ThreadReader } from "@ace/client";
import { useThreadMeta } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { useCallback } from "react";
import { useWatched } from "@/lib/use-watched.ts";
import { agentRunEnds } from "@/lib/agent-run-ends.ts";

const keys = ["order"] as const;

/** Providers can finish a run without ending the reusable agent entity. */
export function useAgentEnd(threadId: string, agent: Agent): number | undefined {
  const scope = agent.childThreadId ?? threadId;
  const child = useThreadMeta(agent.childThreadId);
  const id = agent.childThreadId ? child?.rootAgentId : agent.id;
  const read = useCallback(
    (reader: ThreadReader) => {
      const ends = agentRunEnds(reader, new Set(id ? [id] : []));
      return { value: id ? ends.value.get(id) : undefined, watch: ends.watch };
    },
    [id],
  );
  const end = useWatched(scope, keys, read, Object.is);
  return agent.endedAt ?? end;
}
