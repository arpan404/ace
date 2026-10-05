import { describe, expect, it } from "vitest";
import { progress } from "./index.ts";
import {
  completion,
  effectOf,
  Harness,
  mergeFact,
  plan,
  review,
  spec,
  verifyFact,
} from "./test-support.ts";

describe("completion and integration", () => {
  it("a worker artifact cannot finish a lane while its tree is working or waiting", () => {
    const h = new Harness();
    const lane = h.lane("worker");
    h.send({
      type: "artifact",
      laneId: lane.id,
      generation: 0,
      artifact: { kind: "completion", completion: completion() },
    });
    for (const status of ["working", "waiting"]) {
      h.send({ type: "status", laneId: lane.id, generation: 0, status, at: h.env.now() });
      expect(progress(h.state).dag[0]?.state).toBe("working");
      expect(progress(h.state).lanes.map((l) => l.role)).toEqual(["worker"]);
    }
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
    expect(progress(h.state).lanes.map((l) => l.role)).toEqual(["reviewer"]);
  });
  it("tree done waits for the completion artifact and handles either arrival order", () => {
    const h = new Harness();
    const lane = h.lane("worker");
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
    expect(progress(h.state).dag[0]?.state).toBe("working");
    h.send({
      type: "artifact",
      laneId: lane.id,
      generation: 0,
      artifact: { kind: "completion", completion: completion() },
    });
    expect(progress(h.state).dag[0]?.state).toBe("reviewing");
  });
  it("passing review waits for merge and checks before dependent work can start", () => {
    const h = new Harness(spec(), plan({ a: [], b: ["a"] }));
    h.worker();
    h.reviewer();
    const merge = effectOf(h.effects, "merge");
    expect(progress(h.state).dag.map((n) => n.state)).toEqual(["merging", "pending"]);
    const verification = effectOf(h.send(mergeFact(merge)), "verify");
    expect(progress(h.state).dag.map((n) => n.state)).toEqual(["verifying", "pending"]);
    h.send(verifyFact(verification));
    expect(progress(h.state).dag.map((n) => n.state)).toEqual(["integrated", "working"]);
  });
  it("the root finishes only after every verified integration and live lane has settled", () => {
    const h = new Harness();
    h.worker();
    h.reviewer();
    const verification = effectOf(h.send(mergeFact(effectOf(h.effects, "merge"))), "verify");
    expect(progress(h.state).phase).toBe("running");
    h.send(verifyFact(verification));
    expect(progress(h.state).phase).toBe("done");
    expect(progress(h.state).lanes).toEqual([]);
    expect(h.send({ type: "tick" })).toEqual([]);
  });
  it("old merge and verification attempts cannot settle a newer operation", () => {
    const h = new Harness();
    h.worker();
    h.reviewer();
    const merge = effectOf(h.effects, "merge");
    h.send({ ...mergeFact(merge), operationId: "stale" });
    expect(progress(h.state).dag[0]?.state).toBe("merging");
    const verify = effectOf(h.send(mergeFact(merge)), "verify");
    h.send({ ...verifyFact(verify), revision: "b".repeat(40) });
    expect(progress(h.state).dag[0]?.state).toBe("verifying");
    h.send(verifyFact(verify));
    expect(progress(h.state).phase).toBe("done");
  });
  it("verification failure reaches the user and prevents dependency dispatch", () => {
    const h = new Harness(spec(), plan({ a: [], b: ["a"] }));
    h.worker();
    h.reviewer();
    const verify = effectOf(h.send(mergeFact(effectOf(h.effects, "merge"))), "verify");
    h.send(verifyFact(verify, false));
    expect(progress(h.state).dag.map((n) => n.state)).toEqual(["escalated", "pending"]);
    expect(progress(h.state).needsUser[0]?.kind).toBe("escalation");
  });
  it("a review of another revision or incomplete requirements is rejected atomically", () => {
    const h = new Harness();
    h.worker();
    const lane = h.lane("reviewer");
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
    expect(() =>
      h.send({
        type: "artifact",
        laneId: lane.id,
        generation: 0,
        artifact: { kind: "review", review: review("a"), revision: "b".repeat(40) },
      }),
    ).toThrow("review_revision_mismatch");
    expect(() =>
      h.send({
        type: "artifact",
        laneId: lane.id,
        generation: 0,
        artifact: { kind: "review", review: review("b"), revision: "a".repeat(40) },
      }),
    ).toThrow("review_requirements_mismatch");
    expect(progress(h.state).dag[0]?.state).toBe("reviewing");
    h.reviewer();
    expect(progress(h.state).dag[0]?.state).toBe("merging");
  });
  it("a lane cannot publish an artifact for another role or replace its reviewed artifact", () => {
    const h = new Harness();
    const lane = h.lane("worker");
    expect(() =>
      h.send({
        type: "artifact",
        laneId: lane.id,
        generation: 0,
        artifact: { kind: "plan", plan: plan() },
      }),
    ).toThrow("wrong_lane_artifact");
    h.send({
      type: "artifact",
      laneId: lane.id,
      generation: 0,
      artifact: { kind: "completion", completion: completion() },
    });
    h.send({
      type: "artifact",
      laneId: lane.id,
      generation: 0,
      artifact: { kind: "completion", completion: completion("a", "b".repeat(40)) },
    });
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
    const reviewer = h.lane("reviewer");
    h.finish(reviewer, { kind: "review", review: review("a"), revision: "a".repeat(40) });
    expect(effectOf(h.effects, "merge")).toMatchObject({
      completion: { revision: "a".repeat(40) },
    });
  });
});

describe("review rounds and user gates", () => {
  it("two failed reviews fork fix sessions, then a third pass integrates", () => {
    const h = new Harness();
    const worker = h.lane("worker");
    h.worker();
    h.reviewer("a", "changes_required");
    expect(effectOf(h.effects, "launch")).toMatchObject({
      lane: { source: worker.id, role: "worker" },
    });
    h.worker();
    h.reviewer("a", "changes_required");
    h.worker();
    h.reviewer();
    expect(progress(h.state).dag[0]).toMatchObject({
      fixRounds: 2,
      state: "merging",
      reviews: [
        { verdict: "changes_required" },
        { verdict: "changes_required" },
        { verdict: "pass" },
      ],
    });
  });
  it("review exhaustion asks the user and an explicit retry forks one more fix", () => {
    const h = new Harness(spec({ maxFixRounds: 0 }));
    h.worker();
    h.reviewer("a", "changes_required");
    expect(progress(h.state).dag[0]?.state).toBe("escalated");
    const g = progress(h.state).needsUser[0];
    if (!g) throw new Error("Missing gate");
    h.send({ type: "approve", approval: { gateId: g.id, decision: "approve" } });
    expect(progress(h.state).dag[0]?.state).toBe("working");
    h.worker();
    h.reviewer();
    expect(progress(h.state).dag[0]?.state).toBe("merging");
    expect(() =>
      h.send({ type: "approve", approval: { gateId: g.id, decision: "approve" } }),
    ).toThrow("gate_not_pending");
  });
  it("plan approval supports replacing a validated plan before dispatch", () => {
    const h = new Harness(spec({ planApproval: "required" }));
    expect(progress(h.state).lanes).toEqual([]);
    const g = progress(h.state).needsUser[0];
    if (!g) throw new Error("Missing gate");
    h.send({
      type: "approve",
      approval: { gateId: g.id, decision: "approve", plan: plan({ z: [] }) },
    });
    expect(progress(h.state).dag.map((n) => n.id)).toEqual(["z"]);
    expect(progress(h.state).lanes[0]?.workstream).toBe("z");
  });
  it("ask merge approval is tied to the reviewed branch and a second answer is rejected", () => {
    const h = new Harness(spec({ merge: "ask" }));
    h.worker();
    h.reviewer();
    expect(progress(h.state).dag[0]?.state).toBe("approved");
    const g = progress(h.state).needsUser[0];
    if (!g) throw new Error("Missing gate");
    expect(g.message).toContain("a".repeat(40));
    h.send({ type: "approve", approval: { gateId: g.id, decision: "approve" } });
    expect(effectOf(h.effects, "merge")).toMatchObject({ mode: "local" });
    expect(() =>
      h.send({ type: "approve", approval: { gateId: g.id, decision: "approve" } }),
    ).toThrow("gate_not_pending");
  });
  it("destructive permission requires an explicit answer for the requesting lane", () => {
    const h = new Harness();
    const lane = h.lane("worker");
    h.send({
      type: "destructive",
      laneId: lane.id,
      generation: 0,
      description: "Remove a worktree",
    });
    expect(h.effects.some((e) => e.type === "control")).toBe(false);
    const g = progress(h.state).needsUser[0];
    if (!g) throw new Error("Missing gate");
    const effects = h.send({ type: "approve", approval: { gateId: g.id, decision: "approve" } });
    expect(effects).toContainEqual(
      expect.objectContaining({
        type: "control",
        action: "allow_destructive",
        lane: expect.objectContaining({ id: lane.id }),
      }),
    );
  });
});

it("invalid review artifacts cannot poison a working reviewer before its done status arrives", () => {
  const h = new Harness();
  h.worker();
  const lane = h.lane("reviewer");
  expect(() =>
    h.send({
      type: "artifact",
      laneId: lane.id,
      generation: 0,
      artifact: { kind: "review", review: review("a"), revision: "b".repeat(40) },
    }),
  ).toThrow("review_revision_mismatch");
  h.reviewer();
  expect(progress(h.state).dag[0]?.state).toBe("merging");
});
