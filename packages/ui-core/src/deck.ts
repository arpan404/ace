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
  | "merged";
export interface Round {
  label: string;
  verdict: string;
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
  /** The agent working the card now: a delegated child thread when the daemon has one. */
  agentId: string;
  status: LaneStatus;
  rounds: readonly Round[];
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
}
export interface Gate {
  id: string;
  kind: "plan" | "merge" | "escalation";
  title: string;
  body: string;
  /** The card the gate is about, when it is about one. */
  workstream: string | null;
}
export type DeckPhase =
  | "planning"
  | "dealing"
  | "merging"
  | "merged"
  | "paused"
  | "cancelled"
  | "failed";
export interface DeckRun {
  id: string;
  title: string;
  goal: string;
  workspaceId: string;
  phase: DeckPhase;
  planApproved: boolean;
  /** The decision the deck waits on first; `gates` counts every open one. */
  gate: Gate | null;
  gates: number;
  cards: readonly DeckCard[];
  spent: number;
  budget: number;
  /** Why the deck stopped executing, when it did. */
  error: string | undefined;
  /** Details are loading: the run is known from the list only. */
  partial: boolean;
  /** The plan the gate asks about: each workstream's objective and how it is judged. */
  plan: DeckPlan | null;
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
 * until the deck merges.
 */
export function deckMerge(run: DeckRun): { detail: string; done: boolean; dependencies: string[] } {
  const dependencies = planEnds(run.cards);
  const done = run.phase === "merged";
  const detail = done
    ? "Merged"
    : run.phase === "merging"
      ? "Merging"
      : `Needs all ${run.cards.length}`;
  return { detail, done, dependencies };
}

export type DeckGroup = "gated" | "active" | "finished";

export function deckGroup(run: DeckRun): DeckGroup {
  if (run.gate) return "gated";
  if (run.phase === "merged" || run.phase === "cancelled" || run.phase === "failed")
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

/** The second line of a deck in the sidebar. */
export function deckRunSummary(run: DeckRun): string {
  const { merged, total } = deckProgress(run);
  const tally = `${merged} of ${total} merged`;
  if (run.gate) {
    const ask =
      run.gate.kind === "merge"
        ? "Merge needs approval"
        : run.gate.kind === "escalation"
          ? "Escalation needs you"
          : "Deck plan needs approval";
    return `${ask} · ${tally}`;
  }
  switch (run.phase) {
    case "planning":
      return "Drafting the plan";
    case "dealing": {
      const lanes = run.cards.filter(busy).length;
      return `Dealing · ${lanes} ${lanes === 1 ? "lane" : "lanes"} active`;
    }
    case "merging":
      return "Merging";
    case "paused":
      return `Paused · ${tally}`;
    case "merged":
      return `Merged ${total} ${total === 1 ? "card" : "cards"}`;
    case "cancelled":
      return `Cancelled · ${tally}`;
    case "failed":
      return `Stopped · ${tally}`;
  }
}

export type DeckStepState = "done" | "current" | "todo";
export interface DeckStep {
  label: string;
  state: DeckStepState;
}

/** Goal → Plan approved → Dealing · n of m merged → Merge. */
export function deckSteps(run: DeckRun): DeckStep[] {
  const { merged, total } = deckProgress(run);
  const finished = run.phase === "merged";
  const dealing = run.planApproved && !finished;
  return [
    { label: "Goal", state: "done" },
    {
      label: run.planApproved ? "Plan approved" : "Plan",
      state: run.planApproved ? "done" : "current",
    },
    {
      label: run.planApproved ? `Dealing · ${merged} of ${total} merged` : "Dealing",
      state: finished ? "done" : dealing ? "current" : "todo",
    },
    { label: finished ? "Merged" : "Merge", state: finished ? "done" : "todo" },
  ];
}

/** The Deck stepper: its steps, and whether the current one is paused rather than moving. */
export function deckStepper(run: DeckRun): { steps: DeckStep[]; paused: boolean } {
  return { steps: deckSteps(run), paused: run.phase === "paused" || run.phase === "cancelled" };
}

/** The deck a Deck view opens on: gated first, then active, then the latest. */
export function landingDeck(runs: readonly DeckRun[]): DeckRun | undefined {
  return (
    runs.find((run) => deckGroup(run) === "gated") ??
    runs.find((run) => deckGroup(run) === "active") ??
    runs[0]
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

/** The status line under a card's title, and its pill tone in the lane. */
export function cardStatus(
  card: DeckCard,
  run: DeckRun,
): { label: string; mark: CardMark; tone: CardTone } {
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
      return {
        label: run.gate?.workstream === card.id ? "Waiting for you" : "Escalated",
        mark: "dot",
        tone: "needs-you",
      };
    case "merged":
      return { label: "Merged", mark: "check", tone: "done" };
  }
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
