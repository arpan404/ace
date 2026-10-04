import type { ConductorRunView } from "@ace/protocol";
import type { Gate } from "./deck.ts";

/*
 * A deck's title and its open decisions, from the conductor view. Kept apart from the full
 * mapper (deck-view.ts): the sidebar counts open decisions on every screen.
 */

type View = ConductorRunView;
type Node = View["dag"][number];
type NeedsUser = View["needsUser"][number];

/** "Make every relay stream resumable": the goal's first sentence, short enough for a title. */
export function deckTitle(goal: string): string {
  // A sentence ends at a stop followed by a space or the end, so "0.48" stays whole.
  const first = goal.split(/[.!?](?:\s|$)|\n/)[0]?.trim() || goal.trim();
  return first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first;
}

/**
 * Which decision comes first: a card stopped on a person (an escalation, an agent's question),
 * then what risks work (destructive changes, budget, deadline), then merges, then the plan.
 */
const gateOrder: Record<NeedsUser["kind"], number> = {
  escalation: 0,
  provider: 1,
  destructive: 2,
  budget: 3,
  deadline: 4,
  merge: 5,
  plan: 6,
};

function gateTitle(gate: NeedsUser, card: string | undefined): string {
  switch (gate.kind) {
    case "plan":
      return "Deck plan needs your approval";
    case "merge":
      return card ? `Merge needs your approval: ${card}` : "Merge needs your approval";
    case "budget":
      return "The deck reached its budget";
    case "deadline":
      return "The deck passed its deadline";
    case "destructive":
      return card ? `Destructive change in ${card}` : "A destructive change needs approval";
    case "escalation":
      return card ? `Escalated: ${card}` : "The deck escalated a decision";
    case "provider":
      return card ? `${card} needs your answer` : "An agent needs your answer";
  }
}

/** What the agent is asking, from the daemon's "question needs your answer". */
const providerAsks: Record<string, string> = {
  question: "The agent asked a question. It continues once you answer.",
  approval: "The agent wants to run something that needs your approval.",
  plan_review: "The agent proposed a plan and waits for your review.",
  elicitation: "A tool the agent uses needs input from you.",
};

/** The daemon's own sentence, unless it is a machine line a person can't act on. */
function gateBody(gate: NeedsUser, card: string | undefined): string {
  if (gate.kind === "provider") {
    const kind = /^(\w+) needs your answer$/.exec(gate.message)?.[1];
    return (kind && providerAsks[kind]) ?? gate.message;
  }
  const merge = gate.kind === "merge" ? /^Merge \S+ at ([0-9a-f]{7,64})$/.exec(gate.message) : null;
  if (merge?.[1])
    return `${card ?? "The card"} passed review at ${merge[1].slice(0, 7)}. Approve to merge it into the deck's branch.`;
  return gate.message;
}

function gateOf(gate: NeedsUser, nodes: readonly Node[]): Gate {
  const card = nodes.find((node) => node.id === gate.workstream)?.title;
  const kind =
    gate.kind === "plan" || gate.kind === "merge" || gate.kind === "provider"
      ? gate.kind
      : "escalation";
  return {
    id: gate.id,
    kind,
    title: gateTitle(gate, card),
    body: gateBody(gate, card),
    workstream: gate.workstream,
    gatedAt: gate.gatedAt,
    interaction:
      gate.kind === "provider" && gate.threadId && gate.interactionId
        ? { threadId: gate.threadId, interactionId: gate.interactionId }
        : null,
  };
}

/**
 * Every decision a deck waits on, in the order to take them; within a kind, the one waiting
 * longest first.
 */
export function deckGates(view: Pick<View, "needsUser" | "dag">): Gate[] {
  return view.needsUser
    .toSorted((a, b) => gateOrder[a.kind] - gateOrder[b.kind] || a.gatedAt - b.gatedAt)
    .map((gate) => gateOf(gate, view.dag));
}

/** The decision a deck waits on first. */
export function deckGate(view: Pick<View, "needsUser" | "dag">): Gate | null {
  return deckGates(view)[0] ?? null;
}

const executionErrors: Record<string, string> = {
  deck_workspace_not_found: "The deck's project is no longer on this daemon.",
  deck_planner_missing: "The deck has no planner model to start with.",
  deck_root_agent_missing: "The daemon couldn't start the deck's own thread.",
  deck_root_missing: "The deck lost its own thread.",
  deck_lane_binding_missing: "The daemon lost track of one of the deck's lanes.",
  deck_engine_unavailable: "The daemon's agent engine isn't running.",
  deck_migration_pending: "A lane is still moving to another account.",
  deck_capacity_wait: "Every account the deck may use is busy. It starts when one frees up.",
  conductor_execution_failed: "The daemon couldn't run the deck's next step.",
};

/** Why a deck stopped executing, as a sentence; the code stays visible for unknown cases. */
export function deckErrorText(code: string): string {
  return executionErrors[code] ?? `The daemon couldn't run the deck's next step (${code}).`;
}
