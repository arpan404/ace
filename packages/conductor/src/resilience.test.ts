import { describe, expect, it } from "vitest";
import { progress } from "./index.ts";
import { accounts, completion, effectOf, Harness, mergeFact, plan, spec } from "./test-support.ts";

describe("migration and liveness", () => {
  it("usage limits migrate full-history sessions within provider and account constraints", () => {
    const h = new Harness();
    const worker = h.lane("worker");
    const migration = effectOf(
      h.send({ type: "usage_limit", laneId: worker.id, generation: 0 }),
      "migrate",
    );
    expect(migration).toMatchObject({
      fromAccount: "one",
      lane: { id: worker.id, account: "two", generation: 1 },
    });
    expect(progress(h.state).lanes[0]?.status).toBe("migrating");
    h.send({
      type: "artifact",
      laneId: worker.id,
      generation: 0,
      artifact: { kind: "completion", completion: completion() },
    });
    h.send({ type: "status", laneId: worker.id, generation: 0, status: "done", at: h.env.now() });
    expect(progress(h.state).dag[0]?.state).toBe("working");
    h.send({ type: "migrated", laneId: worker.id, generation: 1 });
    h.worker();
    expect(progress(h.state).dag[0]?.state).toBe("reviewing");
  });
  it("a replacement session cannot complete before its migration is acknowledged", () => {
    const h = new Harness();
    const worker = h.lane("worker");
    h.send({ type: "usage_limit", laneId: worker.id, generation: 0 });
    h.send({
      type: "artifact",
      laneId: worker.id,
      generation: 1,
      artifact: { kind: "completion", completion: completion() },
    });
    h.send({ type: "status", laneId: worker.id, generation: 1, status: "done", at: h.env.now() });
    expect(progress(h.state).lanes[0]?.status).toBe("migrating");
  });
  it("no eligible migration waits for reset and resumes without reserving another cost", () => {
    const config = spec();
    config.constraints.accounts = ["one"];
    const h = new Harness(config);
    const worker = h.lane("worker");
    const spent = progress(h.state).spent;
    h.send({ type: "usage_limit", laneId: worker.id, generation: 0 });
    expect(progress(h.state).lanes[0]?.status).toBe("limited");
    expect(h.send({ type: "tick" })).toEqual([]);
    h.send({ type: "accounts", accounts: [accounts[0]] });
    expect(progress(h.state).lanes[0]?.status).toBe("working");
    expect(progress(h.state).spent).toBe(spent);
    expect(effectOf(h.effects, "control")).toMatchObject({ action: "resume" });
  });
  it("same-account reset cannot resume more lanes than available capacity or quota", () => {
    const config = spec();
    config.constraints.accounts = ["one"];
    const h = new Harness(config, plan({ a: [], b: [] }));
    const a = h.lane("worker", "a"),
      b = h.lane("worker", "b");
    h.send({ type: "usage_limit", laneId: a.id, generation: 0 });
    h.send({ type: "usage_limit", laneId: b.id, generation: 0 });
    h.send({
      type: "accounts",
      accounts: [
        { id: "one", provider: "codex", capacity: 1, externalActive: 0, quota: 1, resetAt: null },
      ],
    });
    expect(progress(h.state).lanes.map((l) => l.status)).toEqual(["working", "limited"]);
  });
  it("stalls escalate once while human waits are exempt from the watchdog", () => {
    const h = new Harness(spec(), plan({ a: [], b: [] }));
    const waiting = h.lane("worker", "a");
    h.send({
      type: "status",
      laneId: waiting.id,
      generation: 0,
      status: "waiting",
      at: h.env.now(),
    });
    h.env.advance(1001);
    h.send({ type: "tick" });
    expect(progress(h.state).needsUser).toHaveLength(1);
    expect(progress(h.state).needsUser[0]?.message).toContain("stalled");
    expect(progress(h.state).lanes.find((l) => l.workstream === "a")?.status).toBe("waiting");
    expect(h.send({ type: "tick" })).toEqual([]);
  });
  it("failure frees capacity but retries wait for a user decision", () => {
    const h = new Harness();
    const lane = h.lane("worker");
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "failed", at: h.env.now() });
    expect(progress(h.state).lanes).toEqual([]);
    expect(progress(h.state).dag[0]?.state).toBe("escalated");
    const g = progress(h.state).needsUser[0];
    if (!g) throw new Error("Missing gate");
    h.send({ type: "approve", approval: { gateId: g.id, decision: "approve" } });
    expect(progress(h.state).dag[0]?.state).toBe("working");
  });
  it("an unresponsive lane is stopped before a replacement can fork", () => {
    const h = new Harness();
    const lane = h.lane("worker");
    h.send({
      type: "status",
      laneId: lane.id,
      generation: 0,
      status: "unresponsive",
      at: h.env.now(),
    });
    const g = progress(h.state).needsUser[0];
    if (!g) throw new Error("Missing gate");
    h.send({ type: "approve", approval: { gateId: g.id, decision: "approve" } });
    expect(h.effects.some((e) => e.type === "launch")).toBe(false);
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
    expect(effectOf(h.effects, "launch")).toMatchObject({ lane: { source: lane.id } });
  });
  it("future and stale activity cannot postpone the watchdog", () => {
    const h = new Harness();
    const lane = h.lane("worker");
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "working", at: 999999 });
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "waiting", at: 99 });
    h.env.advance(1001);
    h.send({ type: "tick" });
    expect(progress(h.state).needsUser[0]?.kind).toBe("escalation");
  });
});

describe("pause, cancel, budgets and conflicts", () => {
  it("pause settles incoming facts but defers new work until resume", () => {
    const h = new Harness();
    h.send({ type: "pause" });
    h.worker();
    expect(progress(h.state).phase).toBe("paused");
    expect(progress(h.state).dag[0]?.state).toBe("review_pending");
    expect(progress(h.state).lanes).toEqual([]);
    h.send({ type: "resume" });
    expect(progress(h.state).lanes[0]?.role).toBe("reviewer");
  });
  it("cancel does not claim completion until all trees acknowledge their stop", () => {
    const h = new Harness(spec(), plan({ a: [], b: [] }));
    const a = h.lane("worker", "a"),
      b = h.lane("worker", "b");
    h.send({ type: "cancel" });
    expect(progress(h.state).phase).toBe("cancelling");
    h.send({ type: "status", laneId: a.id, generation: 0, status: "done", at: h.env.now() });
    expect(progress(h.state).phase).toBe("cancelling");
    h.send({ type: "status", laneId: b.id, generation: 0, status: "done", at: h.env.now() });
    expect(progress(h.state).phase).toBe("cancelled");
    expect(progress(h.state).lanes).toEqual([]);
  });
  it("budget reservations stop dispatch until the user raises the budget", () => {
    const config = spec();
    config.constraints.budget = 1;
    const h = new Harness(config);
    expect(progress(h.state).lanes).toEqual([]);
    const g = progress(h.state).needsUser[0];
    if (!g) throw new Error("Missing gate");
    expect(g.kind).toBe("budget");
    expect(() =>
      h.send({ type: "approve", approval: { gateId: g.id, decision: "approve" } }),
    ).toThrow("budget_must_increase");
    h.send({ type: "approve", approval: { gateId: g.id, decision: "approve", budget: 20 } });
    expect(progress(h.state).lanes[0]?.role).toBe("worker");
  });
  it("deadline expiry needs an explicit extension and cannot be bypassed with resume", () => {
    const config = spec();
    config.constraints.deadline = 101;
    const h = new Harness(config);
    h.env.advance(1);
    h.send({ type: "tick" });
    const g = progress(h.state).needsUser[0];
    if (!g) throw new Error("Missing gate");
    expect(g.kind).toBe("deadline");
    h.send({ type: "resume" });
    expect(progress(h.state).needsUser).toHaveLength(1);
    expect(() =>
      h.send({ type: "approve", approval: { gateId: g.id, decision: "approve", deadline: 101 } }),
    ).toThrow("deadline_must_be_future");
    h.send({ type: "approve", approval: { gateId: g.id, decision: "approve", deadline: 10000 } });
    expect(progress(h.state).needsUser).toEqual([]);
  });
  it.each([true, false])(
    "conflicts route to %s integrator or owner and require another review",
    (trivial) => {
      const h = new Harness();
      h.worker();
      h.reviewer();
      const merge = effectOf(h.effects, "merge");
      h.send({ ...mergeFact(merge, "Conflicting file"), trivial });
      const lane = h.lane(trivial ? "integrator" : "worker");
      expect(effectOf(h.effects, "launch")).toMatchObject({ lane: { source: expect.any(String) } });
      h.finish(lane, { kind: "completion", completion: completion("a", "b".repeat(40)) });
      expect(progress(h.state).dag[0]?.state).toBe("reviewing");
      h.reviewer();
      expect(effectOf(h.effects, "merge")).toMatchObject({
        completion: { revision: "b".repeat(40) },
      });
    },
  );
  it("PR-only reports a CI-verified PR without requesting a local merge", () => {
    const h = new Harness(spec({ merge: "PR-only" }));
    h.worker();
    h.reviewer();
    expect(effectOf(h.effects, "merge")).toMatchObject({ mode: "pr" });
    expect(effectOf(h.send(mergeFact(effectOf(h.effects, "merge"))), "verify")).toMatchObject({
      mode: "pr",
    });
    expect(progress(h.state).dag[0]?.integrationMode).toBe("PR with verified CI");
  });
});

it("failed reviewers retry the review role after user approval", () => {
  const h = new Harness();
  h.worker();
  const lane = h.lane("reviewer");
  h.send({ type: "status", laneId: lane.id, generation: 0, status: "failed", at: h.env.now() });
  const gate = progress(h.state).needsUser[0];
  if (!gate) throw new Error("Missing gate");
  h.send({ type: "approve", approval: { gateId: gate.id, decision: "approve" } });
  expect(progress(h.state).lanes[0]?.role).toBe("reviewer");
});

it("PR-only dependency lanes receive the verified source branch revisions for worktree preparation", () => {
  const h = new Harness(spec({ merge: "PR-only" }), plan({ a: [], b: ["a"] }));
  h.worker();
  h.reviewer();
  const merge = effectOf(h.effects, "merge");
  const verification = effectOf(h.send(mergeFact(merge)), "verify");
  if (verification.type !== "verify") throw new Error("No verification");
  const effects = h.send({
    type: "verified",
    operationId: verification.id,
    workstream: "a",
    revision: verification.revision,
    passed: true,
    summary: "CI passed",
  });
  expect(effectOf(effects, "launch")).toMatchObject({
    lane: { workstream: "b" },
    dependencies: [{ branch: "work/a", revision: "a".repeat(40) }],
  });
});
