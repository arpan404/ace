import { expect, it } from "vitest";
import { gateRequest, progress, threadObservation } from "./index.ts";
import { completion, Harness } from "./test-support.ts";

it("core thread status holds a completed worker while descendants or human interactions remain", () => {
  const h = new Harness();
  const lane = h.lane("worker");
  h.send({
    type: "artifact",
    laneId: lane.id,
    generation: 0,
    artifact: { kind: "completion", completion: completion() },
  });
  const observe = (status: unknown) =>
    threadObservation({ laneId: lane.id, generation: 0, status, at: h.env.now() });
  for (const status of [
    { state: "working", agents: 2 },
    { state: "needs_you", interactions: 1 },
    { state: "waiting", on: "background_task" },
    { state: "waiting", on: "rate_limit" },
  ]) {
    h.send(observe(status));
    expect(progress(h.state).dag[0]?.state).toBe("working");
  }
  h.send(observe({ state: "done" }));
  expect(progress(h.state).dag[0]?.state).toBe("reviewing");
});
it("new threads do not synthesize completion and invalid thread statuses are rejected", () => {
  expect(
    threadObservation({ laneId: "lane", generation: 0, at: 10, status: { state: "new" } }),
  ).toBeNull();
  expect(() =>
    threadObservation({ laneId: "lane", generation: 0, at: 10, status: { state: "done-ish" } }),
  ).toThrow();
});
it("user gates use ace approval requests without inventing another resolution protocol", () => {
  expect(
    gateRequest({
      id: "gate",
      kind: "escalation",
      workstream: "a",
      lane: null,
      generation: null,
      message: "Fix limit exhausted",
    }),
  ).toMatchObject({
    kind: "approval",
    description: "Fix limit exhausted",
    options: [
      { id: "approve", kind: "allow_once" },
      { id: "reject", kind: "deny" },
    ],
  });
});

it("an unknown inherited property name cannot answer a nonexistent gate", () => {
  const h = new Harness();
  expect(() =>
    h.send({ type: "approve", approval: { gateId: "toString", decision: "approve" } }),
  ).toThrow("gate_not_pending");
});
