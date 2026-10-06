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

/** Every agent's subagent count in one pass, children before parents. */
export function subagentCounts(nodes: readonly AgentTreeNode[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: AgentTreeNode): number => {
    let total = 0;
    for (const child of node.children) total += 1 + visit(child);
    counts.set(node.id, total);
    return total;
  };
  for (const node of nodes) visit(node);
  return counts;
}
