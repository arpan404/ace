import { useItem } from "@ace/client-react";
import type { Agent, Item } from "@ace/protocol";
import { agentLabel, agentTask } from "@ace/ui-core";

/**
 * An agent's name and task, read from the call that started it (one item, by id): an unnamed
 * subagent goes by its task rather than "Subagent".
 */
export function useAgentIdentity(
  threadId: string,
  agent: Pick<Agent, "origin" | "native" | "name" | "role" | "spawnedBy"> | undefined,
): { name: string; task: string | undefined; spawn: Item | undefined } {
  const spawn = useItem(threadId, agent?.spawnedBy ?? "");
  const task = agentTask(spawn);
  return { name: agent ? agentLabel(agent, task) : "", task, spawn };
}
