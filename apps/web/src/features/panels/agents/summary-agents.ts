import type { AgentTreeNode } from "@ace/client-react";
import { agentRuns, type AgentRuns, type RunAgent } from "@ace/ui-core";

/** How the Summary lays out a thread's agents. */
export interface SummaryAgents {
  /**
   * What still works: each live agent with only its live subagents under it. An agent whose own
   * turn ended while anything under it works or waits is live, so it is never listed as done.
   */
  working: AgentTreeNode[];
  /** Subagents whose whole branch settled, newest first, one row each. */
  done: AgentTreeNode[];
  /** Runs of agents a provider started again: one row per agent, its earlier runs as history. */
  runs: AgentRuns;
}

const leaf = (id: string): AgentTreeNode => ({ id, children: [] });

/**
 * Fold every earlier run of an agent into its latest run: the earlier run's row goes, and any
 * subagents it had hang under the latest run instead. A run whose latest run isn't loaded stays.
 */
function foldRuns(nodes: readonly AgentTreeNode[], runs: AgentRuns): AgentTreeNode[] {
  if (!runs.latest.size) return [...nodes];
  const present = new Set<string>();
  const visit = (list: readonly AgentTreeNode[]) => {
    for (const node of list) {
      present.add(node.id);
      visit(node.children);
    }
  };
  visit(nodes);
  const hidden = (id: string) => {
    const latest = runs.latest.get(id);
    return latest !== undefined && present.has(latest);
  };
  const adopted = new Map<string, AgentTreeNode[]>();
  const collect = (list: readonly AgentTreeNode[]) => {
    for (const node of list) {
      collect(node.children);
      const latest = runs.latest.get(node.id);
      if (latest !== undefined && hidden(node.id))
        adopted.set(latest, [...(adopted.get(latest) ?? []), ...node.children]);
    }
  };
  collect(nodes);
  const rebuild = (list: readonly AgentTreeNode[]): AgentTreeNode[] =>
    list.flatMap((node) =>
      hidden(node.id)
        ? []
        : [
            {
              id: node.id,
              children: rebuild([...node.children, ...(adopted.get(node.id) ?? [])]),
            },
          ],
    );
  return rebuild(nodes);
}

/**
 * Split the agent tree into what works and what is done. `live` says whether an agent or
 * anything under it still works or waits (`agentTreeWork`); `root` is the thread's main agent,
 * which the Summary's status line speaks for once it rests. Pure.
 */
export function summaryAgents(
  nodes: readonly AgentTreeNode[],
  agents: readonly RunAgent[],
  live: (id: string) => boolean,
): SummaryAgents {
  const runs = agentRuns(agents);
  const root = agents.find((agent) => agent.origin === "root")?.id;
  const done: AgentTreeNode[] = [];
  const settle = (node: AgentTreeNode) => {
    if (node.id !== root) done.push(leaf(node.id));
    for (const child of node.children) settle(child);
  };
  const prune = (node: AgentTreeNode): AgentTreeNode => {
    const children: AgentTreeNode[] = [];
    for (const child of node.children)
      if (live(child.id)) children.push(prune(child));
      else settle(child);
    return { id: node.id, children };
  };
  const working: AgentTreeNode[] = [];
  for (const node of foldRuns(nodes, runs))
    if (live(node.id)) working.push(prune(node));
    else settle(node);
  const created = new Map<string, number>(agents.map((agent) => [agent.id, agent.createdAt]));
  done.sort((left, right) => (created.get(right.id) ?? 0) - (created.get(left.id) ?? 0));
  return { working, done, runs };
}
