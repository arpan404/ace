import { expect, test } from "vitest";
import { progress, nextDeadline } from "./index.ts";
import { Harness, completion, effectOf, mergeFact, spec, plan, review } from "./test-support.ts";

function escalate(h: Harness, role: "worker" | "reviewer" | "integrator") {
  const lane = h.lane(role);
  h.send({
    type: "status",
    laneId: lane.id,
    generation: lane.generation,
    status: "done",
    at: h.env.now(),
  });
  h.env.advance(1000);
  h.send({ type: "tick" });
  const gate = progress(h.state).needsUser.find((entry) => entry.kind === "escalation");
  if (!gate) throw new Error("Missing escalation");
  return { lane, gate };
}

test("resume gives suspended work a fresh stall interval", () => {
  const h = new Harness();
  h.send({ type: "pause" });
  h.env.advance(20_000);
  h.send({ type: "resume" });
  h.send({ type: "tick" });
  expect(progress(h.state).needsUser).toEqual([]);
  expect(nextDeadline(h.state)).toBe(h.env.now() + 1000);
});

test("a launch held by a deadline gate does not expire and gets a fresh interval when released", () => {
  const h = new Harness();
  const lane = h.lane("worker");
  const configured = {
    ...h.state.spec,
    constraints: { ...h.state.spec.constraints, deadline: 200 },
  };
  h.state = { ...h.state, spec: configured };
  h.env.advance(100);
  h.send({ type: "tick" });
  h.env.advance(10_000);
  h.send({ type: "tick" });
  expect(progress(h.state).needsUser.map((entry) => entry.kind)).toEqual(["deadline"]);
  const gate = progress(h.state).needsUser[0];
  if (!gate) throw new Error("Missing deadline");
  h.send({
    type: "approve",
    approval: { gateId: gate.id, decision: "approve", deadline: h.env.now() + 30_000 },
  });
  expect(nextDeadline(h.state)).toBe(h.env.now() + 1000);
  h.send({ type: "status", laneId: lane.id, generation: 0, status: "working", at: h.env.now() });
  expect(progress(h.state).needsUser).toEqual([]);
});

test("retired reviewers release capacity and leave only the current worker and reviewer", () => {
  const h = new Harness();
  h.worker();
  for (let attempt = 0; attempt < 8; attempt++) {
    const { gate } = escalate(h, "reviewer");
    h.send({ type: "approve", approval: { gateId: gate.id, decision: "approve" } });
    expect(progress(h.state).lanes.map((lane) => lane.role)).toEqual(["reviewer"]);
  }
  // Cold state is the public durable API, and its bounds must not grow on retries.
  expect(Object.values(h.state.lanes).filter((lane) => lane.role === "reviewer")).toHaveLength(1);
});

test("retrying a failed trivial-conflict integrator keeps its role and conflict context", () => {
  const h = new Harness();
  h.worker();
  h.reviewer();
  h.send(mergeFact(effectOf(h.effects, "merge"), "conflict in a.txt"));
  const integrator = h.lane("integrator");
  h.send({
    type: "status",
    laneId: integrator.id,
    generation: 0,
    status: "failed",
    at: h.env.now(),
  });
  const gate = progress(h.state).needsUser[0];
  if (!gate) throw new Error("Missing escalation");
  const launch = effectOf(
    h.send({ type: "approve", approval: { gateId: gate.id, decision: "approve" } }),
    "launch",
  );
  if (launch.type !== "launch") throw new Error("Missing launch");
  expect(launch.lane.role).toBe("integrator");
  expect(launch.prompt).toContain("conflict in a.txt");
});

test("review fixes after a resolved conflict do not inherit stale conflict instructions", () => {
  const h = new Harness(spec({ maxFixRounds: 2 }));
  h.worker();
  h.reviewer();
  h.send(mergeFact(effectOf(h.effects, "merge"), "obsolete conflict"));
  h.finish(h.lane("integrator"), {
    kind: "completion",
    completion: completion("a", "b".repeat(40)),
  });
  h.reviewer("a", "changes_required");
  const launch = effectOf(h.effects, "launch");
  if (launch.type !== "launch") throw new Error("Missing launch");
  expect(launch.prompt).not.toContain("obsolete conflict");
});

test("a passing review must cover every acceptance criterion even though a failure report can stop early", () => {
  const cards = plan();
  const expanded = Object.assign({}, cards, {
    workstreams: cards.workstreams.map((card) =>
      Object.assign({}, card, {
        brief: Object.assign({}, card.brief, { acceptance: ["a works", "a survives restart"] }),
      }),
    ),
  });
  const h = new Harness(spec(), expanded);
  h.worker();
  const lane = h.lane("reviewer");
  expect(() =>
    h.finish(lane, { kind: "review", revision: completion().revision, review: review("a") }),
  ).toThrow("review_requirements_mismatch");
  h.finish(lane, {
    kind: "review",
    revision: completion().revision,
    review: Object.assign({}, review("a", "changes_required"), {
      mutations: [],
      flakiness: { runs: 0, passed: false, evidence: "Blocked by failing acceptance" },
    }),
  });
  expect(progress(h.state).dag[0]?.reviews?.[0]?.verdict).toBe("changes_required");
});

test("declining a failed reviewer removes its retired scheduling row", () => {
  const h = new Harness();
  h.worker();
  const lane = h.lane("reviewer");
  h.send({ type: "status", laneId: lane.id, generation: 0, status: "failed", at: h.env.now() });
  const gate = progress(h.state).needsUser[0];
  if (!gate) throw new Error("Missing escalation");
  h.send({ type: "approve", approval: { gateId: gate.id, decision: "reject" } });
  expect(progress(h.state).phase).toBe("done");
  expect(Object.values(h.state.lanes).filter((entry) => entry.role === "reviewer")).toEqual([]);
});
