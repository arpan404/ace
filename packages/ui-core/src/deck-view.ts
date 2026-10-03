import type { ConductorRunView, ConductorSummary } from "@ace/protocol";
import type {
  CardState,
  DeckAgent,
  DeckCard,
  DeckPhase,
  DeckRun,
  Lane,
  LaneRole,
  Round,
} from "./deck.ts";
import {
  agentTimes,
  deckAgents,
  laneRole,
  type DeckAccounts,
  type DeckThreads,
} from "./deck-agents.ts";
import { deckGates, deckTitle } from "./deck-gate.ts";

/*
 * The Deck model from the daemon's conductor view (`conductor.result` / `conductor.changed`).
 * The view carries the plan's workstreams, their node state and fix rounds, the live lanes, the
 * delegated threads and the open gates; everything here is read from those facts.
 */

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
      return "stopping";
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

/** The newest generation of a role on a workstream: retired lanes stay off the card. */
function latest(lanes: readonly ViewLane[], workstream: string, kind: ViewLane["role"]) {
  let found: ViewLane | undefined;
  for (const lane of lanes)
    if (lane.workstream === workstream && lane.role === kind)
      if (!found || lane.generation >= found.generation) found = lane;
  return found;
}

/** A role's live lane, else the agent that last held it (named by account, without a model). */
function roleOf(
  lane: ViewLane | undefined,
  agent: DeckAgent | undefined,
  accounts: DeckAccounts,
): LaneRole | null {
  if (lane) return laneRole(lane.account, lane.model, accounts);
  if (!agent) return null;
  return { account: agent.account, provider: agent.provider, detail: "Finished" };
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

function cardOf(
  node: Node,
  view: View,
  agents: readonly DeckAgent[],
  accounts: DeckAccounts,
): DeckCard {
  const state = cardState(node);
  const fixRounds = node.fixRounds ?? 0;
  const lanes = {
    worker: latest(view.lanes, node.id, "worker") ?? latest(view.lanes, node.id, "integrator"),
    reviewer: latest(view.lanes, node.id, "reviewer"),
  };
  const held = (role: DeckAgent["role"]) => agents.find((agent) => agent.role === role);
  const worker = roleOf(lanes.worker, held("worker") ?? held("integrator"), accounts);
  const reviewer = roleOf(lanes.reviewer, held("reviewer"), accounts);
  const live = lanes.worker ?? lanes.reviewer;
  const current = agents.find((agent) => !agent.nested);
  const lane: Lane | null =
    live || current
      ? {
          worker,
          reviewer,
          threadId: current?.threadId ?? null,
          status: live?.status ?? null,
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
    agents,
    ...agentTimes(agents),
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
    gates: [],
    startedAt: 0,
    updatedAt: 0,
    cards: [],
    agents: [],
    error: undefined,
    partial: true,
    plan: null,
  };
}

const noThreads: DeckThreads = () => undefined;

/**
 * A deck from the conductor's run view, with accounts named from the account list and agent
 * times from the threads this client has (`threads`; without it, agents carry no times).
 */
export function deckFromView(
  view: View,
  accounts: DeckAccounts,
  threads: DeckThreads = noThreads,
): DeckRun {
  const agents = deckAgents(view, accounts, threads);
  const gates = deckGates(view);
  return {
    ...base(view),
    phase: phaseOf(view, view.dag, view.executionError),
    planApproved: view.planApproved,
    gate: gates[0] ?? null,
    gates,
    startedAt: view.startedAt,
    updatedAt: view.updatedAt,
    cards: view.dag.map((node) => cardOf(node, view, agents.get(node.id) ?? [], accounts)),
    agents: agents.get(null) ?? [],
    error: view.executionError,
    partial: false,
    plan: view.plan && {
      summary: view.plan.summary,
      workstreams: view.plan.workstreams.map((workstream) => ({
        id: workstream.id,
        title: workstream.title,
        objective: workstream.brief.objective,
        acceptance: workstream.brief.acceptance,
        dependencies: workstream.dependencies,
      })),
    },
  };
}

/** The goal after the sentence the title came from: what the deck page reads under its title. */
export function deckBrief(goal: string, title: string): string {
  return goal.startsWith(title) ? goal.slice(title.length).replace(/^[.!?\s]+/, "") : goal;
}
