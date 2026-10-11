import type { AgentFacts } from "@/lib/agent-facts.ts";
import { useThreadMeta } from "@ace/client-react";
import type { Agent } from "@ace/protocol";
import { useCallback } from "react";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";

/** Providers can finish a run without ending the reusable agent entity. */
export function useAgentEnd(threadId: string, agent: Agent): number | undefined {
  const scope = agent.childThreadId ?? threadId;
  const child = useThreadMeta(agent.childThreadId);
  const id = agent.childThreadId ? child?.rootAgentId : agent.id;
  const read = useCallback(
    (facts: AgentFacts) => ({
      value: id ? facts.endedAt(id) : undefined,
      watch: id ? [`end:${id}`] : [],
    }),
    [id],
  );
  const end = useAgentFacts(scope, read, Object.is);
  return agent.endedAt ?? end;
}
