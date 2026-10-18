import type { z } from "zod";
import type { AXTree } from "./cdp.ts";

type Tree = z.infer<typeof AXTree>;

/**
 * Drop the accessibility nodes of one DOM subtree (ace's own annotate overlay) so agent
 * snapshots describe only the page. Work is proportional to the tree, once per snapshot.
 */
export function withoutSubtree(tree: Tree, backendNodeId: number | undefined): Tree {
  if (backendNodeId === undefined) return tree;
  const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
  const removed = new Set<string>();
  const pending = tree.nodes
    .filter((node) => node.backendDOMNodeId === backendNodeId)
    .map((node) => node.nodeId);
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || removed.has(id)) continue;
    removed.add(id);
    for (const child of byId.get(id)?.childIds ?? []) pending.push(child);
  }
  if (!removed.size) return tree;
  // The tree was parsed for this snapshot alone, so trimming its child lists in place is safe.
  const nodes = tree.nodes.filter((node) => !removed.has(node.nodeId));
  for (const node of nodes)
    if (node.childIds?.some((child) => removed.has(child)))
      node.childIds = node.childIds.filter((child) => !removed.has(child));
  return { nodes };
}
