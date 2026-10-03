import type { ConductorCommandPayload, ConductorSpec } from "@ace/protocol";
import { deckRuns } from "./decks.ts";
import type { FakeDeckCard, FakeDeckRun, FakeGate } from "./types.ts";

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
        this.replace(
          payload.approval.decision === "approve"
            ? approve(run, gate, now)
            : reject(run, gate, now),
        );
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

/** Cards with every dependency merged start working. */
function deal(cards: FakeDeckCard[]): FakeDeckCard[] {
  const merged = new Set(cards.filter((c) => c.state === "merged").map((c) => c.id));
  return cards.map((c) =>
    c.state === "planned" && c.dependencies.every((dep) => merged.has(dep))
      ? { ...c, state: "working", round: 1, note: "Worker is starting in a fresh worktree." }
      : c,
  );
}

function approve(run: FakeDeckRun, gate: FakeGate, now: number): FakeDeckRun {
  if (gate.kind === "merge") {
    const cards = run.cards.map((c) =>
      c.state === "merge" ? { ...c, state: "merged" as const, note: "Merged to main." } : c,
    );
    return logged({ ...run, phase: "merged", gate: null, cards }, now, "You approved the merge.");
  }
  let cards = run.cards;
  for (const change of gate.changes) {
    if (change.kind === "added") {
      const added: FakeDeckCard = {
        id: change.cardId,
        kind: "work",
        title: change.title,
        dependencies: change.dependencies ?? [],
        state: "planned",
        round: 0,
        lane: null,
        note: change.detail,
      };
      const mergeAt = cards.findIndex((c) => c.kind === "merge");
      cards = mergeAt < 0 ? [...cards, added] : cards.toSpliced(mergeAt, 0, added);
      cards = cards.map((c) =>
        c.kind === "merge" ? { ...c, dependencies: [...c.dependencies, added.id] } : c,
      );
    } else if (change.kind === "removed") {
      cards = cards.filter((c) => c.id !== change.cardId);
    } else {
      cards = cards.map((c) =>
        c.id === change.cardId
          ? { ...c, state: "working" as const, round: c.round + 1, note: change.detail }
          : c,
      );
    }
  }
  const text =
    gate.kind === "escalation"
      ? "You approved the escalation."
      : `You approved plan revision ${gate.revision}.`;
  return logged(
    { ...run, phase: "dealing", planApproved: true, gate: null, cards: deal(cards) },
    now,
    text,
  );
}

function reject(run: FakeDeckRun, gate: FakeGate, now: number): FakeDeckRun {
  if (gate.kind === "plan" && !run.planApproved)
    return logged(
      { ...run, phase: "planning", gate: null },
      now,
      "You rejected the plan. The planner is drafting another revision.",
    );
  return logged(
    { ...run, gate: null },
    now,
    gate.kind === "merge"
      ? "You rejected the merge. The branch stays open."
      : `You rejected plan revision ${gate.revision}. The deck keeps its current plan.`,
  );
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
    title: "Deck plan needs your approval",
    body: `Revision 1: ${cards.length - 1} cards in 3 stages. Nothing starts until you approve.`,
    revision: 1,
    changes: [],
  };
  const run: FakeDeckRun = {
    id,
    title: titleOf(spec.goal),
    goal: spec.goal,
    workspaceId: spec.workspaceId,
    branch: `deck/${id}`,
    phase: auto ? "dealing" : "planning",
    planApproved: auto,
    gate: auto ? null : gate,
    stages: ["Explore", "Build", "Document", "Ship"],
    cards: auto ? deal(cards) : cards,
    log: [
      { at: now, text: "Deck started from the goal." },
      { at: now, text: `Planner proposed ${cards.length - 1} cards.` },
    ],
    pullRequest: null,
    createdAt: now,
    updatedAt: now,
  };
  return run;
}
