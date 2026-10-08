import type { ConductorCommandPayload, ConductorSpec } from "@ace/protocol";
import { heldCards } from "@ace/ui-core/deck";
import type { FakeDeckCard, FakeDeckRun, FakeGate } from "./types.ts";

export function active(run: FakeDeckRun): boolean {
  return run.phase === "planning" || run.phase === "dealing" || run.phase === "merging";
}

export function logged(run: FakeDeckRun, at: number, text: string): FakeDeckRun {
  return { ...run, updatedAt: at, log: [...run.log.slice(-255), { at, text }] };
}

/**
 * The conductor's scheduling pass: nothing moves while the deck is paused, planning or held by
 * a plan, budget or deadline gate. A passed deadline raises its gate; otherwise each card whose
 * dependencies merged starts a lane while the budget admits one more lane start, and the first
 * that doesn't fit raises the budget gate.
 */
export function schedule(run: FakeDeckRun, now: number): FakeDeckRun {
  if (run.phase !== "dealing" && run.phase !== "merging") return run;
  if (
    !run.planApproved ||
    (run.gate && run.gate.kind !== "escalation" && run.gate.kind !== "merge")
  )
    return run;
  if (run.deadline !== undefined && run.deadline !== null && now >= run.deadline)
    return run.gate
      ? run
      : logged(
          { ...run, gate: fakeGate(run, "deadline", "Project deadline reached") },
          now,
          "The deck reached its deadline.",
        );
  const merged = new Set(run.cards.filter((c) => c.state === "merged").map((c) => c.id));
  let spent = run.spent;
  let blocked = false;
  const cards = run.cards.map((c) => {
    if (c.state !== "planned" || !c.dependencies.every((dep) => merged.has(dep))) return c;
    if (spent + 1 > run.budget) {
      blocked = true;
      return c;
    }
    spent++;
    return {
      ...c,
      state: "working" as const,
      round: 1,
      note: "Worker is starting in a fresh worktree.",
    };
  });
  const next = { ...run, cards, spent };
  return blocked && !next.gate ? overBudget(next, now) : next;
}

/** One more lane start doesn't fit: the deck waits on its budget, as the conductor's does. */
function overBudget(run: FakeDeckRun, now: number): FakeDeckRun {
  return logged(
    {
      ...run,
      gate: fakeGate(run, "budget", `Reserved cost ${run.spent + 1} exceeds budget ${run.budget}`),
    },
    now,
    "The deck used its budget.",
  );
}

function fakeGate(run: FakeDeckRun, kind: "budget" | "deadline", body: string): FakeGate {
  return { id: `${run.id}-${kind}-${run.log.length}`, kind, body, cardId: null, revision: 1 };
}

const settledCard = (card: FakeDeckCard) =>
  card.kind === "merge" || card.state === "merged" || card.state === "declined";

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
export function approve(
  run: FakeDeckRun,
  gate: FakeGate,
  approval: Approval,
  now: number,
  held = false,
): FakeDeckRun | string {
  const open = { ...run, gate: null };
  const next = (deck: FakeDeckRun) => (held ? deck : schedule(deck, now));
  switch (gate.kind) {
    case "plan":
      return next(
        logged(
          { ...open, phase: "dealing", planApproved: true },
          now,
          `You approved plan revision ${gate.revision}.`,
        ),
      );
    case "merge": {
      const card = run.cards.find((c) => c.id === gate.cardId);
      if (!card || card.state !== "approved") return "merge_not_ready";
      const cards = withCard(run, card.id, (c) => ({
        ...c,
        state: "merged",
        note: `Merged into ${run.branch}.`,
      }));
      return settle(
        next(logged({ ...open, cards }, now, `You approved merging ${card.title}.`)),
        now,
      );
    }
    case "escalation": {
      const cards = withCard(run, gate.cardId, (c) => ({
        ...c,
        state: "fixing",
        round: c.round + 1,
        note: "A new round starts.",
      }));
      const retried = logged({ ...open, cards }, now, "You asked the deck to retry the card.");
      // The retry is a new lane start; without room for it the deck waits on its budget.
      if (run.spent + 1 > run.budget) return overBudget(retried, now);
      return next({ ...retried, spent: run.spent + 1 });
    }
    case "budget":
      if (approval.budget === undefined || approval.budget <= run.budget)
        return "budget_must_increase";
      return next(
        logged(
          { ...open, budget: approval.budget },
          now,
          `You raised the budget to ${approval.budget} lane starts.`,
        ),
      );
    case "deadline":
      if (approval.deadline === undefined || approval.deadline <= now)
        return "deadline_must_be_future";
      return next(
        logged({ ...open, deadline: approval.deadline }, now, "You extended the deadline."),
      );
    case "destructive":
      return logged(open, now, "You allowed the change.");
  }
}

/** The conductor's reject (packages/conductor approval.ts), never a silent bypass. */
export function reject(
  run: FakeDeckRun,
  gate: FakeGate,
  now: number,
  held = false,
  feedback?: string,
): FakeDeckRun {
  if (gate.kind === "plan") {
    const revision = gate.revision + 1;
    return logged(
      {
        ...run,
        phase: "planning",
        planApproved: false,
        gate: {
          ...gate,
          id: `${run.id}-rev-${revision}`,
          revision,
          body: redraft(run, revision) + (feedback ? `\nUser feedback: ${feedback}` : ""),
        },
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
  const declined = logged({ ...run, gate: null, cards }, now, `You declined ${card.title}.`);
  return settle(held ? declined : schedule(declined, now), now);
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
export function draft(id: string, spec: ConductorSpec, now: number): FakeDeckRun {
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
    deadline: spec.constraints.deadline,
    createdAt: now,
    updatedAt: now,
  };
  // Not even the planner fits: the deck waits on its budget before any plan exists.
  if (spec.constraints.budget < 1)
    return overBudget(
      { ...run, phase: "planning", planApproved: false, gate: null, cards: [], spent: 0 },
      now,
    );
  return schedule(run, now);
}
