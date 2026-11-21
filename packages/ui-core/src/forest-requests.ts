import { isActionableInteraction } from "@ace/core/human";
import type { AgentStatus, Interaction } from "@ace/protocol";
import type { AgentForestNode, ThreadWork } from "./agent-forest.ts";

/*
 * Which of an agent's pending requests the Summary names, shared by Now, the phone's agent rows
 * and the web's tree. One the person can answer now (`isActionableInteraction`) before one they
 * can't, a blocking one before one the agent works on without, then the newest. A thread whose
 * facts aren't confirmed (catching up after a reconnect, or not loaded) names none: its requests
 * may already be answered. Pure.
 */

type Work = Pick<ThreadWork, "agents" | "interactions" | "facts">;

/** Each agent's request to name, by `thread/agent`. */
export type ForestRequests = ReadonlyMap<string, Interaction>;

const rank = (interaction: Interaction, status: AgentStatus | undefined) =>
  (isActionableInteraction(interaction, status) ? 2 : 0) + (interaction.blocking ? 1 : 0);

/** Whether `next` is named ahead of `kept`. */
const ahead = (next: Interaction, kept: Interaction, status: AgentStatus | undefined) => {
  const order = rank(next, status) - rank(kept, status);
  return order > 0 || (order === 0 && next.createdAt > kept.createdAt);
};

const current = (work: Work | undefined) => (work?.facts ?? "live") === "live";

/**
 * The best request of each agent across the tree's threads, indexed once. `actionableOnly`
 * keeps only those the person can answer now, as the rows that wait on the person need.
 * Linear in the agents and requests of the joined threads.
 */
export function forestRequests(
  works: ReadonlyMap<string, Work>,
  actionableOnly = true,
): ForestRequests {
  const index = new Map<string, Interaction>();
  for (const [threadId, work] of works) {
    if (!work.interactions.length || !current(work)) continue;
    const status = new Map<string, AgentStatus>();
    for (const agent of work.agents) status.set(agent.id, agent.status);
    for (const interaction of work.interactions) {
      if (interaction.state !== "pending") continue;
      const owner = status.get(interaction.agentId);
      if (actionableOnly && !isActionableInteraction(interaction, owner)) continue;
      const key = `${threadId}/${interaction.agentId}`;
      const kept = index.get(key);
      if (!kept || ahead(interaction, kept, owner)) index.set(key, interaction);
    }
  }
  return index;
}

/** The request an agent row answers for: its own, else its delegated thread's root's. */
export function forestRequest(
  node: AgentForestNode,
  requests: ForestRequests,
): Interaction | undefined {
  return (
    requests.get(`${node.threadId}/${node.agent.id}`) ??
    (node.childThread && node.childRoot
      ? requests.get(`${node.childThread}/${node.childRoot.id}`)
      : undefined)
  );
}
