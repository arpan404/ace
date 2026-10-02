import { expect, it } from "vitest";
import { apply, recover, rerun, sideBySide, spawnAgent } from "./index.ts";
import { check, complete, fact, setup } from "./test-support.ts";

const comparison = (laneId: string, files: { path: string; additions: number }[]) => ({
  laneId,
  durationMs: 10,
  usage: { tokens: 2, cost: 0 },
  artifact: { checkpoint: "cp", summary: "Summary", tests: { passed: 1, failed: 0 } },
  checksPassed: true,
  files: files.map((f) => ({ ...f, status: "M", deletions: 0, binary: false })),
  filesTruncated: false,
  patch: "patch",
  patchTruncated: false,
});

it("MCP spawn binds the parent to the caller and returns the same lane on retry", () => {
  const r = setup("coordinator", 1);
  const parent = r.lanes[0];
  if (!parent) throw new Error("Missing planner");
  const request = {
    requestId: "mcp-1",
    spec: { provider: "cursor", model: "worker" },
    prompt: "Subtask",
  };
  const first = spawnAgent(r.state, { laneId: parent.id, attempt: 1 }, request, r.ctx);
  const second = spawnAgent(
    recover(JSON.parse(JSON.stringify(r.state))).state,
    { laneId: parent.id, attempt: 1 },
    request,
    r.ctx,
  );
  expect(first.laneId).toBeDefined();
  expect(second.laneId).toBe(first.laneId);
  expect(second.intents).toEqual([]);
  expect(() =>
    spawnAgent(
      r.state,
      { laneId: parent.id, attempt: 1 },
      { ...request, parentId: "forged-parent" },
      r.ctx,
    ),
  ).toThrow();
});
it("a side-by-side summary aligns matching file paths without hiding independent lane changes", () => {
  const summary = sideBySide([
    comparison("a", [{ path: "shared.ts", additions: 2 }]),
    comparison("b", [
      { path: "shared.ts", additions: 3 },
      { path: "other.ts", additions: 4 },
    ]),
  ]);
  expect(
    summary.files.map((f) => [f.path, Object.entries(f.lanes).map(([id, c]) => [id, c.additions])]),
  ).toEqual([
    [
      "shared.ts",
      [
        ["a", 2],
        ["b", 3],
      ],
    ],
    ["other.ts", [["b", 4]]],
  ]);
  expect(summary.truncated).toBe(false);
});
it("a failed merge can be picked again and a pending merge can be cancelled", () => {
  const r = setup("fanout", 1);
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  complete(r.state, a, r.ctx);
  check(r.state, a, r.ctx);
  const pending = r.send({ type: "pick", laneId: a.id, merge: true }).intents[0];
  if (!pending) throw new Error("Missing merge");
  r.send({
    type: "execution.failed",
    ...fact(a),
    intentId: pending.id,
    operation: "merge",
    error: "dirty target",
  });
  expect(r.state.status).toBe("failed");
  const retry = r.send({ type: "pick", laneId: a.id, merge: true }).intents[0];
  expect(retry?.effect.type).toBe("merge");
  expect(retry?.id).not.toBe(pending.id);
  r.send({ type: "cancel" });
  expect(r.state.status).toBe("cancelled");
  expect(recover(JSON.parse(JSON.stringify(r.state))).intents).toEqual([]);
});
it("work resuming in a selected lane revokes a merge that has not executed", () => {
  const r = setup("fanout", 1);
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  complete(r.state, a, r.ctx);
  check(r.state, a, r.ctx);
  const pending = r.send({ type: "pick", laneId: a.id, merge: true }).intents[0];
  if (!pending) throw new Error("Missing merge");
  r.send({ type: "thread", ...fact(a), status: { state: "needs_you", interactions: 1 } });
  expect(r.state.status).toBe("cancelling");
  expect(r.state.winner).toBeUndefined();
  expect(Object.values(r.state.intents).map((i) => i.effect)).toEqual([
    { type: "cancel", ...fact(a) },
  ]);
  r.send({ type: "merged", ...fact(a), intentId: pending.id, safetyCheckpoint: "safety" });
  expect(r.state.mergeStatus).toBe("none");
});
it("the deadline also cancels a pending winner merge", () => {
  const r = setup("fanout", 1);
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  complete(r.state, a, r.ctx);
  check(r.state, a, r.ctx);
  r.send({ type: "pick", laneId: a.id, merge: true });
  r.ctx.now += r.input.template.budget.durationMs;
  r.send({ type: "tick" });
  expect(r.state.status).toBe("budget_exhausted");
  expect(Object.values(r.state.intents)).toEqual([]);
});
it("recovery rejects a status that claims success while live lanes exist", () => {
  const r = setup();
  expect(() => recover({ ...r.state, status: "succeeded" })).toThrow("Invalid run status");
});

it("rerunning a settled orchestration keeps its definition, isolates old results and assigns a new run", () => {
  const r = setup("fanout", 1);
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  expect(() => rerun(r.state, r.ctx)).toThrow("run_still_active");
  complete(r.state, a, r.ctx);
  check(r.state, a, r.ctx);
  const next = rerun(r.state, r.ctx);
  expect(next.state.id).toBe(r.state.id);
  expect(next.state.runId).not.toBe(r.state.runId);
  expect(next.state.input).toEqual(r.state.input);
  expect(next.state.status).toBe("running");
  apply(next.state, { type: "thread", ...fact(a), status: { state: "failed" } }, r.ctx);
  expect(next.state.status).toBe("running");
  expect(r.state.status).toBe("succeeded");
  expect(next.events.every((e) => e.runId === next.state.runId)).toBe(true);
});
