import type { ConductorRunView } from "@ace/protocol";
import type { Gate } from "./deck.ts";

/*
 * A deck's title and its first open decision, from the conductor view. Kept apart from the
 * full mapper (deck-view.ts): the rail counts escalations on every screen.
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

const gateOrder: Record<NeedsUser["kind"], number> = {
  escalation: 0,
  destructive: 1,
  budget: 2,
  deadline: 3,
  merge: 4,
  plan: 5,
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
  }
}

/** The decision a deck waits on first: escalations before merge, merge before the plan. */
export function deckGate(view: Pick<View, "needsUser" | "dag">): Gate | null {
  return gateOf(view.needsUser, view.dag);
}

function gateOf(gates: readonly NeedsUser[], nodes: readonly Node[]): Gate | null {
  const first = gates.toSorted((a, b) => gateOrder[a.kind] - gateOrder[b.kind])[0];
  if (!first) return null;
  const card = nodes.find((node) => node.id === first.workstream)?.title;
  return {
    id: first.id,
    kind: first.kind === "plan" || first.kind === "merge" ? first.kind : "escalation",
    title: gateTitle(first, card),
    body: first.message,
    workstream: first.workstream,
  };
}
