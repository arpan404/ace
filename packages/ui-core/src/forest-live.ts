import { forestAsker, type ForestNode } from "./agent-forest.ts";

/*
 * The Summary's "Still running" list: the tree's live work flattened to one level. Pure.
 */

/** Whether a row is the viewed thread's own main agent: the composer and its row speak for it. */
const isViewedRoot = (node: ForestNode, viewed: string) =>
  node.kind === "agent" && node.agent.origin === "root" && node.threadId === viewed;

/**
 * Every agent that works or waits and every running command, at any depth, in the tree's order,
 * with the agent that needs the person first. A settled-looking row whose facts aren't confirmed
 * stays in the list (it may be working again), so the list is empty only once nothing anywhere
 * might still run. The viewed thread's main agent is left out.
 */
export function stillRunning(roots: readonly ForestNode[], viewed: string): ForestNode[] {
  const rows: ForestNode[] = [];
  const visit = (nodes: readonly ForestNode[]) => {
    for (const node of nodes) {
      const failed = node.kind === "agent" && node.agent.status.state === "failed";
      const running = node.live || (node.unconfirmed && !failed);
      if (running && !isViewedRoot(node, viewed)) rows.push(node);
      visit(node.children);
    }
  };
  visit(roots);
  const asker = forestAsker(roots);
  if (!asker || isViewedRoot(asker, viewed)) return rows;
  return [asker, ...rows.filter((row) => row !== asker)];
}
