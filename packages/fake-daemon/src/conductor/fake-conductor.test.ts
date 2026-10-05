import { progress } from "@ace/conductor";
import { Harness, plan, spec } from "@ace/conductor/test-support";
import { describe, expect, test } from "vitest";
import { accountSummaries } from "../services/accounts.ts";
import { FakeConductor } from "./fake-conductor.ts";
import { runView } from "./run-view.ts";
import type { FakeDeckCard, FakeDeckRun, FakeGate } from "./types.ts";

const relay = (conductor: FakeConductor) => {
  const run = conductor.runs().find((r) => r.id === "relay-streams");
  if (!run) throw new Error("missing relay deck");
  return run;
};

test("approving a card's merge merges it and deals the card waiting on it", () => {
  const conductor = new FakeConductor({ clock: () => 1_000_000 });
  const gate = relay(conductor).gate;
  expect(gate).toMatchObject({ kind: "merge", cardId: "replay-cursor" });

  const result = conductor.command({
    type: "conductor.approve",
    runId: "relay-streams",
    approval: { gateId: gate?.id ?? "", decision: "approve" },
  });

  expect(result).toEqual({ ok: true });
  const run = relay(conductor);
  expect(run.gate).toBeNull();
  const states = Object.fromEntries(run.cards.map((c) => [c.title, c.state]));
  expect(states["Server-side replay cursor"]).toBe("merged");
  expect(states["Migration note and docs"]).toBe("working");
});

test("a decision on a gate that is no longer open is refused", () => {
  const conductor = new FakeConductor({ clock: () => 1 });
  const result = conductor.command({
    type: "conductor.approve",
    runId: "relay-streams",
    approval: { gateId: "relay-streams-rev-1", decision: "approve" },
  });
  expect(result).toEqual({ ok: false, error: "stale_gate" });
  expect(relay(conductor).gate?.kind).toBe("merge");
});

test("pause and resume return the deck to the phase it was in", () => {
  const conductor = new FakeConductor({ clock: () => 1 });
  conductor.command({ type: "conductor.pause", runId: "mobile-cold-start" });
  const paused = conductor.runs().find((r) => r.id === "mobile-cold-start");
  expect(paused?.phase).toBe("paused");
  conductor.command({ type: "conductor.resume", runId: "mobile-cold-start" });
  expect(conductor.runs().find((r) => r.id === "mobile-cold-start")?.phase).toBe("dealing");
});

test("every lane runs on an account the fake accounts.list serves", () => {
  // Seeded decks are dated hours back from now, so now is a real moment.
  const conductor = new FakeConductor({ clock: () => 1_800_000_000_000 });
  for (const scenario of ["planning", "budget", "unresponsive"] as const) conductor.stage(scenario);
  const listed = new Set(accountSummaries(1).map((account) => account.id));
  const lanes = conductor.runs().flatMap((run) => runView(run).lanes);
  expect(lanes.length).toBeGreaterThan(0);
  expect(lanes.filter((lane) => !listed.has(lane.account))).toEqual([]);
});

/*
 * Parity with the real conductor (packages/conductor): the same decision on the same kind of
 * gate leaves the deck in the same place on both, as the daemon's view reports it. The Deck
 * UI's copy for each decision is written against this.
 */
/** Cancelling settles to cancelled once lanes stop; the fake has no lanes to wait for. */
const settled = (phase: string) => (phase === "cancelling" ? "cancelled" : phase);

describe("the fake answers gates as the real conductor does", () => {
  type Kind = FakeGate["kind"];
  type Outcome = { phase: string; card: string | null } | { error: string };

  function real(kind: Kind, decision: "approve" | "reject", budget?: number): Outcome {
    const base = spec({ planApproval: "required", merge: "ask" });
    const config = {
      ...base,
      constraints: {
        ...base.constraints,
        // The planner and both workers fit; the first reviewer doesn't.
        budget: kind === "budget" ? 3 : 200,
        deadline: kind === "deadline" ? 1_000 : null,
      },
    };
    const h = new Harness(config, plan({ a: [], b: [] }));
    if (kind !== "plan") {
      const open = progress(h.state).needsUser[0];
      if (!open) throw new Error("Plan gate missing");
      h.send({ type: "approve", approval: { gateId: open.id, decision: "approve" } });
      const lane = h.lane("worker", "a");
      if (kind === "merge") {
        h.worker("a");
        h.reviewer("a");
      } else if (kind === "escalation")
        h.send({ type: "status", laneId: lane.id, generation: 0, status: "failed", at: 100 });
      else if (kind === "destructive")
        h.send({ type: "destructive", laneId: lane.id, generation: 0, description: "rm" });
      else if (kind === "budget") h.worker("a");
      else {
        h.env.advance(950);
        h.send({ type: "tick" });
      }
    }
    const gate = progress(h.state).needsUser.find((g) => g.kind === kind);
    if (!gate) throw new Error(`No ${kind} gate`);
    try {
      h.send({
        type: "approve",
        approval: { gateId: gate.id, decision, ...(budget ? { budget } : {}) },
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : "unknown" };
    }
    const view = progress(h.state);
    const card = gate.workstream && view.dag.find((node) => node.id === gate.workstream);
    return { phase: settled(view.phase), card: card ? (card.state ?? null) : null };
  }

  function fake(kind: Kind, decision: "approve" | "reject", budget?: number): Outcome {
    const now = 10_000;
    const onCard = kind === "merge" || kind === "escalation" || kind === "destructive";
    const work = (id: string, state: FakeDeckCard["state"]): FakeDeckCard => ({
      id,
      kind: "work",
      title: `Build ${id}`,
      dependencies: [],
      state: kind === "plan" ? "planned" : state,
      round: kind === "plan" ? 0 : 1,
      lane: null,
      note: "",
    });
    const run: FakeDeckRun = {
      id: "parity",
      title: "Parity",
      goal: "Parity",
      workspaceId: "ace",
      branch: "deck/parity",
      phase: kind === "plan" ? "planning" : "dealing",
      planApproved: kind !== "plan",
      gate: { id: "gate", kind, body: "Gate", cardId: onCard ? "a" : null, revision: 1 },
      stages: [],
      cards: [
        work("a", kind === "merge" ? "approved" : kind === "escalation" ? "escalated" : "working"),
        work("b", "working"),
      ],
      log: [],
      pullRequest: null,
      spent: 4,
      budget: 4,
      createdAt: now,
      updatedAt: now,
    };
    const conductor = new FakeConductor({ clock: () => now, runs: [run] });
    const result = conductor.command({
      type: "conductor.approve",
      runId: "parity",
      approval: { gateId: "gate", decision, ...(budget ? { budget } : {}) },
    });
    if (!result.ok) return { error: result.error };
    const next = conductor.runs()[0];
    if (!next) throw new Error("Run missing");
    const view = runView(next);
    const card = onCard ? view.dag.find((node) => node.id === "a") : undefined;
    return { phase: settled(view.phase), card: card ? (card.state ?? null) : null };
  }

  const kinds: readonly Kind[] = [
    "plan",
    "merge",
    "escalation",
    "destructive",
    "budget",
    "deadline",
  ];
  test.each(kinds)("rejecting a %s gate", (kind) => {
    expect(fake(kind, "reject")).toEqual(real(kind, "reject"));
  });
  test("rejects keep the deck going only where the gate is about one card", () => {
    expect(kinds.map((kind) => [kind, real(kind, "reject")])).toEqual([
      ["plan", { phase: "planning", card: null }],
      ["merge", { phase: "running", card: "declined" }],
      ["escalation", { phase: "running", card: "declined" }],
      ["destructive", { phase: "running", card: "declined" }],
      ["budget", { phase: "cancelled", card: null }],
      ["deadline", { phase: "cancelled", card: null }],
    ]);
  });
  test("a budget gate needs a larger budget on both", () => {
    expect(fake("budget", "approve")).toEqual({ error: "budget_must_increase" });
    expect(real("budget", "approve")).toEqual({ error: "budget_must_increase" });
    expect(fake("budget", "approve", 10)).toEqual(real("budget", "approve", 10));
  });
});

/** A fake conductor on a clock the test moves, with one deck started from `config`. */
function started(
  constraints: { budget?: number; deadline?: number | null },
  planApproval: "auto" | "required",
) {
  let now = 1_000_000;
  const conductor = new FakeConductor({ clock: () => now, runs: [] });
  const base = spec({ planApproval });
  const result = conductor.command({
    type: "conductor.start",
    runId: "deck",
    spec: { ...base, constraints: { ...base.constraints, ...constraints } },
  });
  expect(result).toEqual({ ok: true });
  const view = () => {
    const run = conductor.runs().find((entry) => entry.id === "deck");
    if (!run) throw new Error("Deck missing");
    return runView(run);
  };
  const decide = (
    decision: "approve" | "reject",
    extra: { budget?: number; deadline?: number } = {},
  ) =>
    conductor.command({
      type: "conductor.approve",
      runId: "deck",
      approval: { gateId: view().needsUser[0]?.id ?? "", decision, ...extra },
    });
  return { conductor, view, decide, at: (time: number) => (now = time), now: () => now };
}
const working = (view: ReturnType<typeof runView>) =>
  view.dag.filter((node) => node.state === "working").map((node) => node.id);

describe("the fake schedules within the deck's budget, deadline and pause", () => {
  test("a deadline is published, reached, and extended to the value approved", () => {
    const deck = started({ deadline: 1_005_000 }, "required");
    expect(deck.view().deadline).toBe(1_005_000);
    deck.at(1_006_000);
    expect(deck.decide("approve")).toEqual({ ok: true });
    // Past its deadline the approved plan starts nothing; the deck asks for more time.
    expect(deck.view().needsUser.map((gate) => gate.kind)).toEqual(["deadline"]);
    expect(working(deck.view())).toEqual([]);
    expect(deck.decide("approve", { deadline: 1_000 })).toEqual({
      ok: false,
      error: "deadline_must_be_future",
    });
    expect(deck.decide("approve", { deadline: 1_020_000 })).toEqual({ ok: true });
    expect(deck.view().deadline).toBe(1_020_000);
    expect(working(deck.view())).toEqual(["map"]);
  });

  test("a card starts only when the budget admits its lane, and raising it lets it start", () => {
    // The planner's lane uses the only lane start.
    const deck = started({ budget: 1 }, "auto");
    expect(deck.view()).toMatchObject({ spent: 1, budget: 1 });
    expect(deck.view().needsUser.map((gate) => gate.kind)).toEqual(["budget"]);
    expect(working(deck.view())).toEqual([]);
    expect(deck.decide("approve", { budget: 1 })).toEqual({
      ok: false,
      error: "budget_must_increase",
    });
    expect(deck.decide("approve", { budget: 3 })).toEqual({ ok: true });
    expect(deck.view()).toMatchObject({ spent: 2, budget: 3, needsUser: [] });
    expect(working(deck.view())).toEqual(["map"]);
  });

  test("a deck with no budget can't even start its planner", () => {
    const deck = started({ budget: 0 }, "auto");
    expect(deck.view()).toMatchObject({ phase: "planning", spent: 0, dag: [] });
    expect(deck.view().needsUser.map((gate) => gate.kind)).toEqual(["budget"]);
  });

  test("a paused deck takes a decision but starts nothing until it resumes", () => {
    const deck = started({}, "required");
    expect(deck.conductor.command({ type: "conductor.pause", runId: "deck" })).toEqual({
      ok: true,
    });
    expect(deck.decide("approve")).toEqual({ ok: true });
    expect(deck.view()).toMatchObject({ phase: "paused", planApproved: true, needsUser: [] });
    expect(working(deck.view())).toEqual([]);
    expect(deck.conductor.command({ type: "conductor.resume", runId: "deck" })).toEqual({
      ok: true,
    });
    expect(deck.view().phase).toBe("running");
    expect(working(deck.view())).toEqual(["map"]);
  });
});
