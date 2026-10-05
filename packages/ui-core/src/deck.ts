import type { ProviderKind } from "@ace/protocol";

/*
 * What the Deck screens render: a conductor run ("a deck"), its workstreams ("cards") and
 * each card's lane (worker, adversarial reviewer, review rounds). Pure types and rules only.
 */

export type CardState =
  | "planned"
  | "working"
  | "in_review"
  | "fixing"
  | "merging"
  | "escalated"
  /** You rejected its merge or escalation: it never merges. */
  | "declined"
  | "merged";
export interface Round {
  label: string;
  verdict: string;
  /** What the reviewer said, when the daemon reports the round's review. */
  summary?: string | undefined;
  /** How the verdict reads: passed, sent back, or still open. */
  tone?: "done" | "needs-you" | "working" | undefined;
}
export interface LaneRole {
  /** The account's label ("Claude Code · Work"), or "Account removed" when the daemon doesn't list it. */
  account: string;
  /** Unknown when the lane's account isn't one the daemon lists. */
  provider: ProviderKind | undefined;
  /** The model the lane runs. */
  detail: string;
}
export type LaneStatus =
  | "starting"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "unresponsive"
  | "limited"
  | "migrating";
export interface Lane {
  worker: LaneRole | null;
  reviewer: LaneRole | null;
  /** The thread working the card now (or last), when the daemon has delegated one. */
  threadId: string | null;
  /** Unknown once every lane of the card has retired. */
  status: LaneStatus | null;
  rounds: readonly Round[];
}
export type DeckAgentRole = "planner" | "worker" | "reviewer" | "integrator" | "subagent";
/**
 * One delegated thread of a deck: a lane's worker, reviewer, fix or planner session, or a
 * `delegate_task` child one of them started. Settled agents stay listed: their threads remain.
 */
export interface DeckAgent {
  threadId: string;
  agentId: string | null;
  /** Unknown when the lane retired and its thread isn't on this client yet. */
  role: DeckAgentRole | null;
  /** "Worker", "Reviewer, round 2", "Sub-agent". */
  label: string;
  /** The account's label, or the CLI's default login for `local.<provider>`. */
  account: string;
  provider: ProviderKind | undefined;
  generation: number;
  /** Still running (or being cancelled); false once the delegation settled. */
  live: boolean;
  /** A child of another agent of this deck rather than of the deck itself. */
  nested: boolean;
  /** From the agent's thread, when this client has it. */
  startedAt: number | undefined;
  updatedAt: number | undefined;
}
export interface DeckCard {
  id: string;
  title: string;
  dependencies: readonly string[];
  state: CardState;
  /** Review rounds so far, counting the current one; 0 before the card is dealt. */
  round: number;
  lane: Lane | null;
  /** One sentence for a card without a lane: what it waits for, or how it merged. */
  note: string;
  /** Every agent the deck delegated for this card, newest generation first. */
  agents: readonly DeckAgent[];
  /** The first of its agents' threads to start and the latest to change. */
  startedAt: number | undefined;
  updatedAt: number | undefined;
}
/** What the conductor asks (`needsUser[].kind`): each is decided its own way. */
export type GateAsk =
  | "plan"
  | "merge"
  | "escalation"
  | "budget"
  | "deadline"
  | "destructive"
  | "provider";
export interface Gate {
  id: string;
  /** Budget, deadline and destructive-change gates read as escalations; `ask` tells them apart. */
  kind: "plan" | "merge" | "escalation" | "provider";
  ask: GateAsk;
  title: string;
  body: string;
  /** The daemon's own line, when `body` puts it in words: shown on request. */
  detail: string | undefined;
  /** The card the gate is about, when it is about one. */
  workstream: string | null;
  /** When the deck began waiting on it; 0 when the daemon didn't record it. */
  gatedAt: number;
  /** A provider's question or approval: answered in its thread, never with conductor.approve. */
  interaction: { threadId: string; interactionId: string } | null;
}
export type DeckPhase =
  | "planning"
  | "dealing"
  /** Running, but waiting for a free account or a lane's move to finish: it resumes by itself. */
  | "waiting"
  | "merging"
  | "merged"
  /** Done with some cards declined: everything that could merge did. */
  | "finished"
  | "paused"
  /** Cancel was accepted; lanes are still stopping. */
  | "stopping"
  | "cancelled"
  | "failed";
export interface DeckRun {
  id: string;
  title: string;
  goal: string;
  workspaceId: string;
  phase: DeckPhase;
  planApproved: boolean;
  /** The decision the deck waits on first, and every open one in the order to answer them. */
  gate: Gate | null;
  gates: readonly Gate[];
  /** When the deck started and last changed; 0 until its view arrives. */
  startedAt: number;
  updatedAt: number;
  cards: readonly DeckCard[];
  /** Agents not tied to one card: the planner and its children. */
  agents: readonly DeckAgent[];
  spent: number;
  budget: number;
  /** Why the deck stopped executing, when it did. */
  error: string | undefined;
  /** Details are loading: the run is known from the list only. */
  partial: boolean;
  /** The plan the gate asks about: each workstream's objective and how it is judged. */
  plan: DeckPlan | null;
  /** The branch cards merge into and the one it started from, once the daemon reports them. */
  branch: string | null;
  baseBranch: string | null;
  /** "auto" when the plan starts without asking; unknown on daemons that don't say. */
  planApproval: "required" | "auto" | undefined;
  /**
   * How reviewed cards land: merged into the Deck branch (asking first, or not), or pushed as a
   * pull request from it that the person merges. Unknown on daemons that don't say.
   */
  merge: "ask" | "auto-after-verification" | "PR-only" | undefined;
  /** When the deck stops on its own, if it has a deadline. */
  deadline: number | null;
}

export interface DeckPlan {
  summary: string;
  workstreams: readonly {
    id: string;
    title: string;
    objective: string;
    acceptance: readonly string[];
    dependencies: readonly string[];
  }[];
}

/** The cards nothing else waits on: the last of each line of work, which the merge follows. */
export function planEnds(cards: readonly Pick<DeckCard, "id" | "dependencies">[]): string[] {
  const needed = new Set(cards.flatMap((card) => card.dependencies));
  return cards.filter((card) => !needed.has(card.id)).map((card) => card.id);
}

/**
 * Where the plan ends: one merge after every card that nothing else waits on. "Needs all 6"
 * until the deck merges; an ended deck says why nothing more will.
 */
export function deckMerge(run: DeckRun): { detail: string; done: boolean; dependencies: string[] } {
  const dependencies = planEnds(run.cards);
  const { merged, total } = deckProgress(run);
  // Cards integrate into the Deck's own branch; PR-only decks end at a pull request from it,
  // which the person merges. Nothing here lands on the base branch.
  const into = run.branch ? ` into ${run.branch}` : "";
  const landed =
    run.merge === "PR-only" ? `PR open${run.branch ? ` from ${run.branch}` : ""}` : `Merged${into}`;
  const ended: Partial<Record<DeckPhase, string>> = {
    merged: landed,
    finished:
      run.merge === "PR-only"
        ? `${merged} of ${total} in the PR`
        : `Merged ${merged} of ${total}${into}`,
    merging: "Merging",
    cancelled: "Won't merge",
    stopping: "Won't merge",
    failed: "On hold",
  };
  const detail = ended[run.phase];
  return {
    detail: detail ?? `Needs all ${total}`,
    done: run.phase === "merged" || run.phase === "finished",
    dependencies,
  };
}

/** Declined cards and the planned cards that wait on one, directly or not: none will run. */
export function heldCards(
  cards: readonly { id: string; dependencies: readonly string[]; state: string }[],
): ReadonlySet<string> {
  const known = heldMemo.get(cards);
  if (known) return known;
  // One pass over the edges: each card is visited once from the declined ones.
  const dependants = new Map<string, { id: string; state: string }[]>();
  for (const card of cards)
    for (const id of card.dependencies) {
      const list = dependants.get(id);
      if (list) list.push(card);
      else dependants.set(id, [card]);
    }
  const queue = cards.filter((card) => card.state === "declined").map((card) => card.id);
  const held = new Set(queue);
  for (let at = 0; at < queue.length; at++)
    for (const next of dependants.get(queue[at] ?? "") ?? [])
      if (next.state === "planned" && !held.has(next.id)) {
        held.add(next.id);
        queue.push(next.id);
      }
  heldMemo.set(cards, held);
  return held;
}
/** Each card list is a run's snapshot: its closure is worked out once, not per card. */
const heldMemo = new WeakMap<object, ReadonlySet<string>>();

/** Sidebar groups, in order: decks that need you, stopped ones, moving ones, ended ones. */
export type DeckGroup = "gated" | "stopped" | "active" | "finished";

export function deckGroup(run: DeckRun): DeckGroup {
  if (run.gate) return "gated";
  if (run.phase === "failed") return "stopped";
  if (run.phase === "merged" || run.phase === "finished" || run.phase === "cancelled")
    return "finished";
  return "active";
}

/** "2 of 6 merged". */
export function deckProgress(run: DeckRun): { merged: number; total: number } {
  const merged = run.cards.filter((card) => card.state === "merged").length;
  return { merged, total: run.cards.length };
}

const busy = (card: DeckCard) =>
  card.state === "working" || card.state === "fixing" || card.state === "in_review";

const askLabels: Record<GateAsk, string> = {
  plan: "Plan needs approval",
  merge: "Merge needs approval",
  escalation: "Needs your decision",
  budget: "Budget used up",
  deadline: "Deadline passed",
  destructive: "Change needs approval",
  provider: "An agent asked you",
};

/** What a deck is doing, in a few words: the sidebar row and the lane tab's header. */
export function deckState(run: DeckRun): string {
  if (run.gate) return askLabels[run.gate.ask];
  switch (run.phase) {
    case "planning":
      return "Drafting the plan";
    case "dealing": {
      const lanes = run.cards.filter(busy).length;
      return lanes ? `${lanes} ${lanes === 1 ? "lane" : "lanes"} working` : "Dealing";
    }
    case "waiting":
      return "Waiting for an account";
    case "merging":
      return "Merging";
    case "paused":
      return "Paused";
    case "stopping":
      return "Stopping";
    case "merged":
      return run.merge === "PR-only" ? "PR open" : "Merged";
    case "finished":
      return "Finished";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Stopped";
  }
}

/** The second line of a deck in the sidebar: "2/6 merged · Merge needs approval". */
export function deckRunSummary(run: DeckRun): string {
  const { merged, total } = deckProgress(run);
  if (!total) return deckState(run);
  return `${merged}/${total} merged · ${deckState(run)}`;
}

export type DeckStepState = "done" | "current" | "todo";
export interface DeckStep {
  label: string;
  state: DeckStepState;
}

/** Goal → Plan approved → Dealing · n of m merged → Merge. */
export function deckSteps(run: DeckRun): DeckStep[] {
  const { merged, total } = deckProgress(run);
  const finished = run.phase === "merged" || run.phase === "finished";
  const ended = run.phase === "cancelled" || run.phase === "stopping";
  const dealing = run.planApproved && !finished;
  const plan = run.planApproved
    ? run.planApproval === "auto"
      ? "Plan auto-approved"
      : "Plan approved"
    : run.plan
      ? "Plan ready"
      : "Drafting the plan";
  const last =
    run.phase === "finished"
      ? "Finished"
      : finished
        ? run.merge === "PR-only"
          ? "PR open"
          : "Merged"
        : run.phase === "cancelled"
          ? "Cancelled"
          : run.phase === "stopping"
            ? "Stopping"
            : "Merge";
  return [
    { label: "Goal", state: "done" },
    { label: plan, state: run.planApproved ? "done" : "current" },
    {
      label: run.planApproved ? `Dealing · ${merged} of ${total} merged` : "Dealing",
      // A deck cancelled while dealing did deal: the step happened, the merge never will.
      state: finished || (ended && run.planApproved) ? "done" : dealing ? "current" : "todo",
    },
    { label: last, state: finished ? "done" : ended ? "current" : "todo" },
  ];
}

/** The Deck stepper: its steps, and whether the current one is held rather than moving. */
export function deckStepper(run: DeckRun): { steps: DeckStep[]; paused: boolean } {
  const held =
    ["paused", "stopping", "cancelled", "failed", "waiting"].includes(run.phase) || !!run.gate;
  return { steps: deckSteps(run), paused: held };
}

const newest = (a: DeckRun, b: DeckRun) => b.updatedAt - a.updatedAt;

/**
 * The deck a Deck view opens on: the one waiting longest on a decision, then the most recently
 * active, then the latest to change.
 */
export function landingDeck(runs: readonly DeckRun[]): DeckRun | undefined {
  const gated = runs
    .filter((run) => deckGroup(run) === "gated")
    .toSorted((a, b) => (a.gate?.gatedAt ?? 0) - (b.gate?.gatedAt ?? 0));
  return (
    gated[0] ??
    runs.filter((run) => deckGroup(run) === "active").toSorted(newest)[0] ??
    runs.toSorted(newest)[0]
  );
}

/**
 * Cards in dependency columns: a card sits one column right of its deepest dependency.
 * Unknown dependencies are ignored and cycles are cut, so a bad plan still renders.
 */
export function cardColumns(cards: readonly DeckCard[]): DeckCard[][] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (card: DeckCard): number => {
    const known = depth.get(card.id);
    if (known !== undefined) return known;
    if (visiting.has(card.id)) return 0;
    visiting.add(card.id);
    let value = 0;
    for (const id of card.dependencies) {
      const dependency = byId.get(id);
      if (dependency) value = Math.max(value, depthOf(dependency) + 1);
    }
    visiting.delete(card.id);
    depth.set(card.id, value);
    return value;
  };
  const columns: DeckCard[][] = [];
  for (const card of cards) (columns[depthOf(card)] ??= []).push(card);
  return Array.from(columns, (column) => column ?? []);
}

export type CardMark = "check" | "spinner" | "dot";
export type CardTone = "idle" | "waiting" | "needs-you" | "working" | "done";

const laneHold: Partial<Record<LaneStatus, { label: string; tone: CardTone }>> = {
  limited: { label: "Waiting for quota", tone: "waiting" },
  migrating: { label: "Moving to another account", tone: "waiting" },
  unresponsive: { label: "Not responding", tone: "needs-you" },
  failed: { label: "Lane failed", tone: "needs-you" },
};

/** The status line under a card's title, and its pill tone in the lane. */
export function cardStatus(
  card: DeckCard,
  run: DeckRun,
): { label: string; mark: CardMark; tone: CardTone } {
  const asks = run.gates.filter((gate) => gate.workstream === card.id);
  if (asks.some((gate) => gate.kind === "provider" || gate.kind === "escalation"))
    return { label: "Waiting for you", mark: "dot", tone: "needs-you" };
  if (asks.some((gate) => gate.kind === "merge"))
    return { label: "Ready to merge", mark: "dot", tone: "needs-you" };
  const moving = card.state !== "planned" && card.state !== "merged";
  // A held deck holds its cards: nothing on them moves until it resumes, or ever, once cancelled.
  if (moving && run.phase === "paused") return { label: "Paused", mark: "dot", tone: "idle" };
  if (moving && run.phase === "stopping")
    return { label: "Stopping", mark: "spinner", tone: "waiting" };
  if (card.state === "declined") return { label: "Declined", mark: "dot", tone: "idle" };
  if (card.state !== "merged" && run.phase === "cancelled")
    return { label: "Cancelled", mark: "dot", tone: "idle" };
  if (card.state === "planned" && heldCards(run.cards).has(card.id))
    return { label: "Won't start", mark: "dot", tone: "idle" };
  const hold = card.lane?.status ? laneHold[card.lane.status] : undefined;
  if (hold && (card.state === "working" || card.state === "fixing" || card.state === "in_review"))
    return { ...hold, mark: "dot" };
  switch (card.state) {
    case "planned":
      return { label: "Planned", mark: "dot", tone: "idle" };
    case "working":
      return { label: "Working", mark: "spinner", tone: "working" };
    case "in_review":
      return { label: "In review", mark: "dot", tone: "waiting" };
    case "fixing":
      return { label: `Fixing, round ${card.round}`, mark: "spinner", tone: "working" };
    case "merging":
      return { label: "Merging", mark: "spinner", tone: "working" };
    case "escalated":
      return { label: "Escalated", mark: "dot", tone: "needs-you" };
    case "merged":
      return { label: "Merged", mark: "check", tone: "done" };
  }
}

/** Lanes in the order to look at them, each group named: what needs you comes first. */
export function laneGroups(run: DeckRun): { label: string; cards: DeckCard[] }[] {
  const groups = [
    { label: "Needs you", cards: [] as DeckCard[] },
    { label: "Working", cards: [] as DeckCard[] },
    { label: "In review", cards: [] as DeckCard[] },
    { label: "Planned", cards: [] as DeckCard[] },
    { label: "Merged", cards: [] as DeckCard[] },
    { label: "Declined", cards: [] as DeckCard[] },
  ];
  const [needsYou, working, review, planned, merged, declined] = groups;
  for (const card of run.cards) {
    const tone = cardStatus(card, run).tone;
    const group =
      tone === "needs-you"
        ? needsYou
        : card.state === "merged"
          ? merged
          : card.state === "declined"
            ? declined
            : card.state === "in_review"
              ? review
              : card.state === "planned"
                ? planned
                : working;
    group?.cards.push(card);
  }
  return groups.filter((group) => group.cards.length > 0);
}

/** The card a deck opens on: the one most likely to need a look. */
export function defaultCard(run: DeckRun): DeckCard | undefined {
  const order: CardState[] = ["escalated", "fixing", "in_review", "working", "merging"];
  for (const state of order) {
    const card = run.cards.find((c) => c.state === state && c.lane);
    if (card) return card;
  }
  return run.cards[0];
}
