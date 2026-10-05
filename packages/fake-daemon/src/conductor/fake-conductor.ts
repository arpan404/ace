import type { ConductorCommandPayload, ConductorSpec } from "@ace/protocol";
import { deckRuns, stagedDeck } from "./decks.ts";
import type { FakeDeckCard, FakeDeckRun, FakeDeckScenario, FakeGate } from "./types.ts";

export type FakeConductorResult = { ok: true } | { ok: false; error: string };

/**
 * An in-memory conductor that serves deck runs and applies the real `conductor.*` command
 * payloads to them: start drafts a plan behind a plan gate, approve applies the gate, pause,
 * resume and cancel move the phase. Every change replaces the runs array, so readers can
 * compare by reference.
 */
export class FakeConductor {
  private clock: () => number;
  private list: readonly FakeDeckRun[];
  private paused = new Map<string, FakeDeckRun["phase"]>();
  private listeners = new Set<() => void>();
  constructor(options: { clock(): number; runs?: FakeDeckRun[] }) {
    this.clock = options.clock;
    this.list = options.runs ?? deckRuns(options.clock());
  }
  runs(): readonly FakeDeckRun[] {
    return this.list;
  }
  /** Replace every run, as a conductor restored from its store. */
  load(runs: FakeDeckRun[]): void {
    this.list = runs;
    this.paused.clear();
    this.emit();
  }
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 64) throw new Error("subscription_limit");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  command(payload: ConductorCommandPayload): FakeConductorResult {
    if (payload.type === "conductor.start") {
      if (this.list.length >= 64) return { ok: false, error: "run_limit" };
      if (this.find(payload.runId)) return { ok: false, error: "already_exists" };
      this.list = [draft(payload.runId, payload.spec, this.clock()), ...this.list];
      this.emit();
      return { ok: true };
    }
    const run = this.find(payload.runId);
    if (!run) return { ok: false, error: "not_found" };
    const now = this.clock();
    switch (payload.type) {
      case "conductor.approve": {
        const gate = run.gate;
        if (!gate || gate.id !== payload.approval.gateId) return { ok: false, error: "stale_gate" };
        const next =
          payload.approval.decision === "approve"
            ? approve(run, gate, payload.approval, now)
            : reject(run, gate, now);
        if (typeof next === "string") return { ok: false, error: next };
        this.replace(next);
        return { ok: true };
      }
      case "conductor.pause":
        if (!active(run)) return { ok: false, error: "not_running" };
        this.paused.set(run.id, run.phase);
        this.replace(logged({ ...run, phase: "paused" }, now, "You paused the deck."));
        return { ok: true };
      case "conductor.resume": {
        if (run.executionError) {
          const { executionError: _, ...rest } = run;
          this.replace(logged(rest, now, "You resumed the deck."));
          return { ok: true };
        }
        const phase = this.paused.get(run.id);
        if (run.phase !== "paused" || !phase) return { ok: false, error: "not_paused" };
        this.paused.delete(run.id);
        this.replace(logged({ ...run, phase }, now, "You resumed the deck."));
        return { ok: true };
      }
      case "conductor.cancel":
        if (run.phase === "merged" || run.phase === "cancelled")
          return { ok: false, error: "finished" };
        this.replace(
          logged({ ...run, phase: "cancelled", gate: null }, now, "You cancelled the deck."),
        );
        return { ok: true };
    }
  }
  /** Add a staged deck (a first plan, a used budget, an unresponsive lane) to the runs. */
  stage(scenario: FakeDeckScenario): void {
    const run = stagedDeck(scenario, this.clock());
    if (this.find(run.id)) return;
    this.list = [run, ...this.list];
    this.emit();
  }
  /** The conductor couldn't run the deck's next step; it stays stopped until resumed. */
  fail(runId: string, code: string): void {
    const run = this.find(runId);
    if (run) this.replace({ ...run, executionError: code, updatedAt: this.clock() });
  }
  /** The person answered a worker's question: its card carries on. */
  answer(runId: string, cardId: string): void {
    const run = this.find(runId);
    const card = run?.cards.find((entry) => entry.id === cardId);
    if (!run || !card?.question) return;
    const cards = run.cards.map((entry) =>
      entry.id === cardId ? { ...entry, question: null } : entry,
    );
    this.replace(logged({ ...run, cards }, this.clock(), `You answered ${card.title}.`));
  }
  private find(id: string): FakeDeckRun | undefined {
    return this.list.find((run) => run.id === id);
  }
  private replace(next: FakeDeckRun): void {
    this.list = this.list.map((run) => (run.id === next.id ? next : run));
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function active(run: FakeDeckRun): boolean {
  return run.phase === "planning" || run.phase === "dealing" || run.phase === "merging";
}

function logged(run: FakeDeckRun, at: number, text: string): FakeDeckRun {
  return { ...run, updatedAt: at, log: [...run.log.slice(-255), { at, text }] };
}

/** Cards with every dependency merged start working; each new lane is one lane start spent. */
function deal(run: FakeDeckRun, cards: FakeDeckCard[]): Pick<FakeDeckRun, "cards" | "spent"> {
  const merged = new Set(cards.filter((c) => c.state === "merged").map((c) => c.id));
  let spent = run.spent;
  const next = cards.map((c) => {
    if (c.state !== "planned" || !c.dependencies.every((dep) => merged.has(dep))) return c;
    spent++;
    return {
      ...c,
      state: "working" as const,
      round: 1,
      note: "Worker is starting in a fresh worktree.",
    };
  });
  return { cards: next, spent };
}

const settledCard = (card: FakeDeckCard) =>
  card.kind === "merge" || card.state === "merged" || card.state === "declined";

/**
 * Cards that can never run: declined ones and every planned card waiting on one. A deck whose
 * other cards are merged has finished, as the conductor's does.
 */
export function heldCards(cards: readonly FakeDeckCard[]): Set<string> {
  const held = new Set(cards.filter((c) => c.state === "declined").map((c) => c.id));
  for (let changed = held.size > 0; changed;) {
    changed = false;
    for (const c of cards)
      if (!held.has(c.id) && c.state === "planned" && c.dependencies.some((d) => held.has(d))) {
        held.add(c.id);
        changed = true;
      }
  }
  return held;
}

/** The deck merged everything it still could: its merge card is done, or it ended without one. */
function settle(run: FakeDeckRun, now: number): FakeDeckRun {
  const held = heldCards(run.cards);
  const work = run.cards.filter((c) => c.kind === "work");
  if (!work.every((c) => settledCard(c) || held.has(c.id))) return run;
  const merged = work.some((c) => c.state === "merged");
  const cards = run.cards.map((c) =>
    c.kind === "merge" && merged
      ? { ...c, state: "merged" as const, note: `Merged into ${run.branch}.` }
      : c,
  );
  return logged({ ...run, phase: "merged", cards }, now, "Nothing else can merge.");
}

const withCard = (
  run: FakeDeckRun,
  cardId: string | null,
  change: (card: FakeDeckCard) => FakeDeckCard,
) => run.cards.map((c) => (c.id === cardId ? change(c) : c));

type Approval = Extract<ConductorCommandPayload, { type: "conductor.approve" }>["approval"];

/** The conductor's approve: a raised budget and a later deadline are required, not implied. */
function approve(
  run: FakeDeckRun,
  gate: FakeGate,
  approval: Approval,
  now: number,
): FakeDeckRun | string {
  const open = { ...run, gate: null };
  switch (gate.kind) {
    case "plan":
      return logged(
        { ...open, phase: "dealing", planApproved: true, ...deal(run, run.cards) },
        now,
        `You approved plan revision ${gate.revision}.`,
      );
    case "merge": {
      const card = run.cards.find((c) => c.id === gate.cardId);
      if (!card || card.state !== "approved") return "merge_not_ready";
      const dealt = deal(
        run,
        withCard(run, card.id, (c) => ({
          ...c,
          state: "merged",
          note: `Merged into ${run.branch}.`,
        })),
      );
      return settle(logged({ ...open, ...dealt }, now, `You approved merging ${card.title}.`), now);
    }
    case "escalation": {
      const cards = withCard(run, gate.cardId, (c) => ({
        ...c,
        state: "fixing",
        round: c.round + 1,
        note: "A new round starts.",
      }));
      return logged(
        { ...open, cards, spent: run.spent + 1 },
        now,
        "You asked the deck to retry the card.",
      );
    }
    case "budget":
      if (approval.budget === undefined || approval.budget <= run.budget)
        return "budget_must_increase";
      return logged(
        { ...open, budget: approval.budget },
        now,
        `You raised the budget to ${approval.budget} lane starts.`,
      );
    case "deadline":
      if (approval.deadline === undefined || approval.deadline <= now)
        return "deadline_must_be_future";
      return logged(open, now, "You extended the deadline.");
    case "destructive":
      return logged(open, now, "You allowed the change.");
  }
}

/** The conductor's reject (packages/conductor approval.ts), never a silent bypass. */
function reject(run: FakeDeckRun, gate: FakeGate, now: number): FakeDeckRun {
  if (gate.kind === "plan") {
    const revision = gate.revision + 1;
    return logged(
      {
        ...run,
        phase: "planning",
        planApproved: false,
        gate: { ...gate, id: `${run.id}-rev-${revision}`, revision, body: redraft(run, revision) },
      },
      now,
      `You rejected plan revision ${gate.revision}. The planner drafted revision ${revision}.`,
    );
  }
  const card = run.cards.find((c) => c.id === gate.cardId);
  if (gate.kind === "budget" || gate.kind === "deadline" || !card)
    return logged({ ...run, phase: "cancelled", gate: null }, now, "You stopped the deck.");
  const cards = withCard(run, card.id, (c) => ({
    ...c,
    state: "declined",
    note: "You declined this card. It won't merge.",
  }));
  return settle(logged({ ...run, gate: null, cards }, now, `You declined ${card.title}.`), now);
}

function redraft(run: FakeDeckRun, revision: number): string {
  const count = run.cards.filter((c) => c.kind === "work").length;
  return `Revision ${revision}: ${count} cards. Nothing starts until you approve.`;
}

function titleOf(goal: string): string {
  const first = goal.split(/[.\n]/)[0]?.trim() || goal.trim();
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

function planned(
  cardId: string,
  title: string,
  dependencies: string[],
  note: string,
): FakeDeckCard {
  return {
    id: cardId,
    kind: cardId === "merge" ? "merge" : "work",
    title,
    dependencies,
    state: cardId === "merge" ? "merge" : "planned",
    round: 0,
    lane: null,
    note,
  };
}

/** A first plan for a new goal: map, build, test, document, merge. */
function draft(id: string, spec: ConductorSpec, now: number): FakeDeckRun {
  const cards = [
    planned("map", "Map the current behaviour", [], "Reads the code paths the goal touches."),
    planned("change", "Make the change", ["map"], "Implements the goal behind the existing API."),
    planned("tests", "Behaviour tests", ["map"], "Covers the goal's acceptance criteria."),
    planned("docs", "Docs and migration note", ["change"], "Updates docs for the new behaviour."),
    planned("merge", "Merge to main", ["change", "tests", "docs"], "Merges once all cards pass."),
  ];
  const auto = spec.policies.planApproval === "auto";
  const gate: FakeGate = {
    id: `${id}-rev-1`,
    kind: "plan",
    body: `Revision 1: ${cards.length - 1} cards in 3 stages. Nothing starts until you approve.`,
    cardId: null,
    revision: 1,
  };
  const run: FakeDeckRun = {
    id,
    title: titleOf(spec.goal),
    goal: spec.goal,
    workspaceId: spec.workspaceId,
    branch: `deck/${id}`,
    phase: auto ? "dealing" : "planning",
    planApproved: auto,
    planApproval: spec.policies.planApproval,
    gate: auto ? null : gate,
    stages: ["Explore", "Build", "Document", "Ship"],
    cards,
    log: [
      { at: now, text: "Deck started from the goal." },
      { at: now, text: `Planner proposed ${cards.length - 1} cards.` },
    ],
    pullRequest: null,
    // The planner's lane is the first start.
    spent: 1,
    budget: spec.constraints.budget,
    createdAt: now,
    updatedAt: now,
  };
  return auto ? { ...run, ...deal(run, cards) } : run;
}
