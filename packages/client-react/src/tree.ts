import type { ThreadReader } from "@ace/client";
import { useThread } from "./thread.ts";

export interface AgentTreeNode {
  id: string;
  children: AgentTreeNode[];
}

/** Agents nested under their parents; roots are agents with no loaded parent. */
export function agentTree(reader: ThreadReader): AgentTreeNode[] {
  const ids = reader.agentIds();
  const known = new Set(ids);
  const visiting = new Set<string>();
  const build = (id: string): AgentTreeNode => {
    visiting.add(id);
    const children = reader
      .children(id)
      .filter((child) => known.has(child) && !visiting.has(child))
      .map(build);
    visiting.delete(id);
    return { id, children };
  };
  const rootId = reader.thread?.rootAgentId;
  const roots = ids.filter((id) => {
    const parent = reader.agent(id)?.parentId;
    return !parent || !known.has(parent);
  });
  // The thread's root agent leads; other parentless agents follow in creation order.
  roots.sort((a, b) => Number(b === rootId) - Number(a === rootId));
  return roots.map(build);
}
export function treeEqual(a: readonly AgentTreeNode[], b: readonly AgentTreeNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((node, index) => {
    const other = b[index];
    return !!other && node.id === other.id && treeEqual(node.children, other.children);
  });
}

/**
 * The thread's agent tree as ids only. It changes shape only when agents are created or
 * re-parented; render each node's status with useAgent so status updates stay local.
 */
export function useAgentTree(threadId: string | undefined): readonly AgentTreeNode[] | undefined {
  return useThread(threadId, ["agents", "thread"], agentTree, treeEqual);
}
