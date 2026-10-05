import type { AgentTreeNode } from "@ace/client-react";

/** How many agents work under `node`, at any depth: what stopping it also stops. */
export const countSubagents = (node: AgentTreeNode): number =>
  node.children.reduce((sum, child) => sum + 1 + countSubagents(child), 0);

/** The node for agent `id` in a thread's tree. */
export function findAgentNode(
  nodes: readonly AgentTreeNode[],
  id: string,
): AgentTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findAgentNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/** "Stop resume-sweep and its 2 subagents", or "Stop resume-sweep". */
export const stopLabel = (name: string, subagents: number) =>
  subagents
    ? `Stop ${name} and its ${subagents} ${subagents === 1 ? "subagent" : "subagents"}`
    : `Stop ${name}`;
