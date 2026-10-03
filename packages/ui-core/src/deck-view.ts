import type { ConductorRunView, ConductorSummary, ProviderKind } from "@ace/protocol";
import type { CardState, DeckCard, DeckPhase, DeckRun, Lane, LaneRole, Round } from "./deck.ts";
import { deckGate, deckTitle } from "./deck-gate.ts";

/*
 * The Deck model from the daemon's conductor view (`conductor.result` / `conductor.changed`).
 * The view carries the plan's workstreams, their node state and fix rounds, the live lanes and
 * the open gates; everything here is read from those facts, nothing is invented.
 */

/** What the daemon's account list says about a lane's account. */
export interface DeckAccount {
  label: string;
  provider: ProviderKind;
}
export type DeckAccounts = (id: string) => DeckAccount | undefined;

type View = ConductorRunView;
type ViewLane = View["lanes"][number];
type Node = View["dag"][number];

function phaseOf(run: ConductorSummary, nodes: readonly Node[], error: string | undefined) {
  switch (run.phase) {
    case "planning":
      return error ? "failed" : "planning";
    case "running":
      if (error) return "failed";
      return nodes.length > 0 && nodes.every((node) => node.state === "integrated")
        ? "merging"
        : "dealing";
    case "paused":
      return "paused";
    case "cancelling":
    case "cancelled":
      return "cancelled";
    case "done":
      return "merged";
  }
}

/** The conductor's node states, in the Deck's words. A node not yet scheduled is planned. */
function cardState(node: Node): CardState {
  switch (node.state) {
    case "working":
      return (node.fixRounds ?? 0) > 0 ? "fixing" : "working";
    case "review_pending":
    case "reviewing":
      return "in_review";
    case "fix_pending":
      return "fixing";
    case "approved":
    case "merging":
    case "verifying":
    case "conflict_pending":
      return "merging";
    case "escalated":
      return "escalated";
    case "integrated":
      return "merged";
    default:
      return "planned";
  }
}

function role(lane: ViewLane | undefined, accounts: DeckAccounts): LaneRole | null {
  if (!lane) return null;
  const account = accounts(lane.account);
  return {
    account: account?.label ?? lane.account,
    provider: account?.provider,
    detail: lane.model,
  };
}

/** The newest generation of a role on a workstream: retired lanes stay off the card. */
function latest(lanes: readonly ViewLane[], workstream: string, kind: ViewLane["role"]) {
  let found: ViewLane | undefined;
  for (const lane of lanes)
    if (lane.workstream === workstream && lane.role === kind)
      if (!found || lane.generation >= found.generation) found = lane;
  return found;
}

/** Every fix round followed a review that asked for changes; the last round is the current one. */
function rounds(fixRounds: number, state: CardState): Round[] {
  const done: Round[] = Array.from({ length: fixRounds }, (_, index) => ({
    label: `Round ${index + 1}`,
    verdict: "Changes required",
  }));
  if (state === "planned") return done;
  const current = {
    working: "Working",
    fixing: "Fixing",
    in_review: "In review",
    merging: "Approved",
    escalated: "Escalated",
    merged: "Approved",
  }[state];
  return [...done, { label: `Round ${fixRounds + 1}`, verdict: current }];
}

function note(node: Node, state: CardState, nodes: readonly Node[], approved: boolean): string {
  if (state === "merged")
    return node.revision ? `Merged at ${node.revision.slice(0, 7)}.` : "Merged.";
  const waits = node.dependencies.flatMap(
    (id) => nodes.find((other) => other.id === id)?.title ?? [],
  );
  if (waits.length) return `Starts after ${waits.join(", ")}.`;
  return approved ? "Starts when a lane is free." : "Starts once the plan is approved.";
}

function cardOf(node: Node, view: View, accounts: DeckAccounts): DeckCard {
  const state = cardState(node);
  const fixRounds = node.fixRounds ?? 0;
  const worker = latest(view.lanes, node.id, "worker");
  const reviewer = latest(view.lanes, node.id, "reviewer");
  const current = worker ?? reviewer;
  const lane: Lane | null = current
    ? {
        worker: role(worker, accounts),
        reviewer: role(reviewer, accounts),
        agentId: current.agentId,
        status: current.status,
        rounds: rounds(fixRounds, state),
      }
    : null;
  return {
    id: node.id,
    title: node.title,
    dependencies: node.dependencies,
    state,
    round: state === "planned" ? 0 : fixRounds + 1,
    lane,
    note: note(node, state, view.dag, view.planApproved),
  };
}

const base = (summary: ConductorSummary) => ({
  id: summary.id,
  title: deckTitle(summary.goal),
  goal: summary.goal,
  workspaceId: summary.workspaceId,
  spent: summary.spent,
  budget: summary.budget,
});

/** A deck known only from `conductor.list`: no plan, lanes or gates yet. */
export function deckFromSummary(summary: ConductorSummary): DeckRun {
  return {
    ...base(summary),
    phase: phaseOf(summary, [], undefined) satisfies DeckPhase,
    planApproved: false,
    gate: null,
    gates: 0,
    cards: [],
    error: undefined,
    partial: true,
  };
}

/** A deck from the conductor's run view, with lane accounts named from the account list. */
export function deckFromView(view: View, accounts: DeckAccounts): DeckRun {
  return {
    ...base(view),
    phase: phaseOf(view, view.dag, view.executionError),
    planApproved: view.planApproved,
    gate: deckGate(view),
    gates: view.needsUser.length,
    cards: view.dag.map((node) => cardOf(node, view, accounts)),
    error: view.executionError,
    partial: false,
  };
}

/** The goal after the sentence the title came from: what the deck page reads under its title. */
export function deckBrief(goal: string, title: string): string {
  return goal.startsWith(title) ? goal.slice(title.length).replace(/^[.!?\s]+/, "") : goal;
}
