import type { Agent, Interaction, InteractionRequest } from "@ace/protocol";
import { isActionableInteraction } from "@ace/core/human";
import { approvalCopy } from "./approval-copy.ts";

/*
 * Everything in a thread's agent tree that waits on the person, in one list: requests to answer
 * first (oldest first), then agents that failed, then agents that went silent. Pure.
 */

export type NeedsYouItem =
  | {
      kind: "request";
      /** The interaction to answer. */
      id: string;
      agentId: string;
      request: InteractionRequest["kind"];
      title: string;
    }
  | {
      /** An agent waiting on the person for a request this thread doesn't hold (a delegated child's). */
      kind: "waiting";
      agentId: string;
    }
  | { kind: "failed"; agentId: string; message: string }
  | { kind: "stuck"; agentId: string; since: number };

function line(text: string | undefined): string | undefined {
  const first = text
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return first ? first.replace(/\s+/g, " ") : undefined;
}

/** A request in one line: what it asks the person to allow, answer or review. */
export function requestTitle(request: InteractionRequest): string {
  switch (request.kind) {
    case "approval":
      return approvalCopy(request).title;
    case "question":
      return line(request.questions[0]?.text) ?? "Answer a question";
    case "plan_review":
      return line(request.title) ?? "Review the plan";
    case "elicitation":
      return line(request.title) ?? line(request.message) ?? `Answer ${request.server}`;
    case "browser_help":
      return line(request.title) ?? line(request.message) ?? "Help in the browser";
  }
}

/**
 * What needs the person across the tree: pending requests they can act on, agents waiting on a
 * request held elsewhere, failed agents and unresponsive ones. Each agent appears once, under the
 * most urgent of its states.
 */
export function needsYou(
  agents: readonly Agent[],
  interactions: readonly Interaction[],
): NeedsYouItem[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const requests = interactions
    .filter((interaction) =>
      isActionableInteraction(interaction, byId.get(interaction.agentId)?.status),
    )
    .toSorted((left, right) => left.createdAt - right.createdAt);
  const asking = new Set(requests.map((interaction) => interaction.agentId));
  const items: NeedsYouItem[] = requests.map((interaction) => ({
    kind: "request",
    id: interaction.id,
    agentId: interaction.agentId,
    request: interaction.request.kind,
    title: requestTitle(interaction.request),
  }));
  for (const agent of agents)
    if (
      agent.status.state === "blocked" &&
      agent.status.on === "human" &&
      !asking.has(agent.id) &&
      agent.childThreadId
    )
      items.push({ kind: "waiting", agentId: agent.id });
  for (const agent of agents)
    if (agent.status.state === "failed")
      items.push({
        kind: "failed",
        agentId: agent.id,
        message: line(agent.status.error.message) ?? "Couldn't finish",
      });
  for (const agent of agents)
    if (agent.status.state === "unresponsive")
      items.push({ kind: "stuck", agentId: agent.id, since: agent.status.lastSignalAt });
  return items;
}
