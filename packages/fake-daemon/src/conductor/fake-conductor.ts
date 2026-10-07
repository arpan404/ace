import { Key, StartSpec } from "@ace/conductor/commands";
import { ConductorCommandPayload, type ConductorSpec } from "@ace/protocol";
import { approve, reject, logged, schedule, overBudget } from "./simulation.ts";
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
  private receipts = new Map<string, FakeConductorResult>();
  private sequence = 0;
  private validateStart: ((spec: ConductorSpec) => string | undefined) | undefined;
  private clock: () => number;
  private list: readonly FakeDeckRun[];
  private paused = new Map<string, FakeDeckRun["phase"]>();
  private listeners = new Set<() => void>();
  constructor(options: {
    clock(): number;
    runs?: FakeDeckRun[];
    validateStart?(spec: ConductorSpec): string | undefined;
  }) {
    this.validateStart = options.validateStart;
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
    this.receipts.clear();
    this.emit();
  }
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 64) throw new Error("subscription_limit");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  command(
    payload: ConductorCommandPayload,
    receipt = `fake.${++this.sequence}`,
  ): FakeConductorResult {
    if (!Key.safeParse(receipt).success || !ConductorCommandPayload.safeParse(payload).success)
      return { ok: false, error: "conductor_command_failed" };
    const key = `${payload.runId}/${receipt}`;
    const previous = this.receipts.get(key);
    if (previous) return previous;
    if (this.receipts.size >= 65_536) return { ok: false, error: "input_backpressure" };
    const result = this.apply(payload);
    this.receipts.set(key, result);
    return result;
  }
  private apply(payload: ConductorCommandPayload): FakeConductorResult {
    if (payload.type === "conductor.start") {
      if (this.find(payload.runId)) return { ok: true };
      if (!StartSpec.safeParse(payload.spec).success)
        return { ok: false, error: "conductor_invalid_root_agent" };
      const error = this.validateStart?.(payload.spec);
      if (error) return { ok: false, error };
      if (this.list.length >= 64) return { ok: false, error: "run_limit" };
      this.list = [draft(payload.runId, payload.spec, this.clock()), ...this.list];
      this.emit();
      return { ok: true };
    }
    const run = this.find(payload.runId);
    if (!run) return { ok: false, error: "run_not_found" };
    if (run.phase === "merged" || run.phase === "cancelled") return { ok: true };
    const now = this.clock();
    switch (payload.type) {
      case "conductor.approve": {
        const gate = run.gate;
        if (!gate || gate.id !== payload.approval.gateId)
          return { ok: false, error: "gate_not_pending" };
        // A paused deck takes the decision but schedules nothing until it resumes.
        const held = run.phase === "paused";
        const base = held ? { ...run, phase: this.paused.get(run.id) ?? "dealing" } : run;
        const next =
          payload.approval.decision === "approve"
            ? approve(base, gate, payload.approval, now, held)
            : reject(base, gate, now, held);
        if (typeof next === "string") return { ok: false, error: next };
        if (held && next.phase !== "cancelled" && next.phase !== "merged") {
          this.paused.set(run.id, next.phase);
          this.replace({ ...next, phase: "paused" });
        } else {
          this.paused.delete(run.id);
          this.replace(next);
        }
        return { ok: true };
      }
      case "conductor.pause":
        if (!active(run)) return { ok: true };
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
        if (run.phase !== "paused" || !phase) return { ok: true };
        this.paused.delete(run.id);
        this.replace(schedule(logged({ ...run, phase }, now, "You resumed the deck."), now));
        return { ok: true };
      }
      case "conductor.cancel":
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
