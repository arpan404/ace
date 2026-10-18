import type { z } from "zod";
import type { AXTree } from "./cdp.ts";

type Tree = z.infer<typeof AXTree>;

/**
 * Pages above this many DOM nodes get an outline instead of a full snapshot: reading their whole
 * accessibility tree takes seconds and tens of megabytes (300,000 nodes: ~5.6 s, ~98 MB).
 */
export const outlineDomNodes = 50_000;
/** Landmarks and headings: enough to see the page's parts and pass one's ref to snapshot it. */
export const outlineRoles = ["main", "navigation", "form", "dialog", "heading"] as const;
export const outlineHint =
  "This page is too large for a full snapshot, so only its landmarks and headings are listed. Pass one's ref to browser_snapshot to read that part, or use browser_find, browser_wait_for text or a screenshot.";

/**
 * Keep the first node (the root) and its descendants at most `depth` levels below it. Work is
 * proportional to the tree, once per snapshot.
 */
export function limitDepth(tree: Tree, depth: number): Tree {
  const root = tree.nodes[0];
  if (!root) return tree;
  const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
  const kept = new Set<string>([root.nodeId]);
  let level = [root.nodeId];
  for (let current = 0; current < depth && level.length; current++) {
    const next: string[] = [];
    for (const id of level)
      for (const child of byId.get(id)?.childIds ?? [])
        if (!kept.has(child) && byId.has(child)) {
          kept.add(child);
          next.push(child);
        }
    level = next;
  }
  if (kept.size === tree.nodes.length) return tree;
  return { nodes: tree.nodes.filter((node) => kept.has(node.nodeId)) };
}
