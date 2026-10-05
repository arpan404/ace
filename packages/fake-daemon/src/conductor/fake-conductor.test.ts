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
describe("the fake answers gates as the real conductor does", () => {
  type Kind = FakeGate["kind"];
  type Outcome = { phase: string; card: string | null } | { error: string };
  /** Cancelling settles to cancelled once lanes stop; the fake has no lanes to wait for. */
  const settled = (phase: string) => (phase === "cancelling" ? "cancelled" : phase);

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
