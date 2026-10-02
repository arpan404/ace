import { expect, it } from "vitest";
import { recover } from "./index.ts";
import { check, complete, fact, setup } from "./test-support.ts";

it("nested coordinator tasks obey depth limits and keep the planner waiting for a human-blocked child", () => {
  const r = setup("coordinator", 1, { maxDepth: 2 });
  const root = r.lanes[0];
  if (!root) throw new Error("Missing planner");
  const spawn = (parentId: string, requestId: string) =>
    r.send({
      type: "spawn",
      parentId,
      attempt: 1,
      requestId,
      spec: { provider: "cursor", model: "worker" },
      prompt: "Implement subtask",
    });
  const childId = spawn(root.id, "child").intents[0]?.effect.laneId;
  if (!childId) throw new Error("Missing child");
  const child = r.state.lanes[childId];
  if (!child) throw new Error("Missing child");
  const nestedId = spawn(child.id, "nested").intents[0]?.effect.laneId;
  if (!nestedId) throw new Error("Missing nested task");
  const nested = r.state.lanes[nestedId];
  if (!nested) throw new Error("Missing nested task");
  expect(spawn(nested.id, "too-deep").events).toContainEqual({
    type: "orchestration.rejected",
    orchestrationId: r.state.id,
    runId: r.state.runId,
    reason: "depth_limit",
  });
  expect(spawn(root.id, "child").intents).toEqual([]);
  complete(r.state, root, r.ctx);
  complete(r.state, child, r.ctx);
  r.send({ type: "thread", ...fact(nested), status: { state: "needs_you", interactions: 1 } });
  expect(r.state.status).toBe("waiting");
  expect(root.phase).toBe("joining");
  expect(child.phase).toBe("joining");
  expect(recover(JSON.parse(JSON.stringify(r.state))).state.status).toBe("waiting");
  complete(r.state, nested, r.ctx);
  check(r.state, nested, r.ctx);
  check(r.state, child, r.ctx);
  expect(r.state.status).toBe("running");
  check(r.state, root, r.ctx);
  expect(r.state.status).toBe("succeeded");
});
it("a failed nested task fails its otherwise idle planner", () => {
  const r = setup("coordinator", 1);
  const root = r.lanes[0];
  if (!root) throw new Error("Missing root");
  const id = r.send({
    type: "spawn",
    parentId: root.id,
    attempt: 1,
    requestId: "child",
    spec: root.spec,
    prompt: "Subtask",
  }).intents[0]?.effect.laneId;
  if (!id) throw new Error("Missing child");
  const child = r.state.lanes[id];
  if (!child) throw new Error("Missing child");
  complete(r.state, root, r.ctx);
  r.send({ type: "thread", ...fact(child), status: { state: "failed" } });
  expect(root.phase).toBe("failed");
  expect(r.state.status).toBe("failed");
});
it("planner cancellation waits for its own stop acknowledgement and every descendant", () => {
  const r = setup("coordinator", 1);
  const root = r.lanes[0];
  if (!root) throw new Error("Missing root");
  const id = r.send({
    type: "spawn",
    parentId: root.id,
    attempt: 1,
    requestId: "child",
    spec: root.spec,
    prompt: "Subtask",
  }).intents[0]?.effect.laneId;
  if (!id) throw new Error("Missing child");
  const child = r.state.lanes[id];
  if (!child) throw new Error("Missing child");
  complete(r.state, root, r.ctx);
  const cancellation = r.send({ type: "cancel" });
  expect(cancellation.intents.filter((i) => i.effect.type === "cancel")).toHaveLength(2);
  r.send({ type: "stopped", ...fact(child) });
  expect(r.state.status).toBe("cancelling");
  r.send({ type: "stopped", ...fact(root) });
  expect(r.state.status).toBe("cancelled");
});
it("a planner stopping first still waits until its nested thread tree stops", () => {
  const r = setup("coordinator", 1);
  const root = r.lanes[0];
  if (!root) throw new Error("Missing root");
  const id = r.send({
    type: "spawn",
    parentId: root.id,
    attempt: 1,
    requestId: "child",
    spec: root.spec,
    prompt: "Subtask",
  }).intents[0]?.effect.laneId;
  if (!id) throw new Error("Missing child");
  const child = r.state.lanes[id];
  if (!child) throw new Error("Missing child");
  r.send({ type: "cancel" });
  r.send({ type: "stopped", ...fact(root) });
  expect(r.state.status).toBe("cancelling");
  r.send({ type: "stopped", ...fact(child) });
  expect(r.state.status).toBe("cancelled");
});
it("total lanes are bounded and non-coordinator templates cannot spawn", () => {
  const r = setup("coordinator", 1, { maxLanes: 1 });
  const root = r.lanes[0];
  if (!root) throw new Error("Missing root");
  expect(
    r.send({
      type: "spawn",
      parentId: root.id,
      attempt: 1,
      requestId: "child",
      spec: root.spec,
      prompt: "Subtask",
    }).events[0],
  ).toMatchObject({ reason: "lane_limit" });
  const fan = setup("fanout", 1);
  const a = fan.lanes[0];
  if (!a) throw new Error("Missing lane");
  expect(
    fan.send({
      type: "spawn",
      parentId: a.id,
      attempt: 1,
      requestId: "child",
      spec: a.spec,
      prompt: "Subtask",
    }).events[0],
  ).toMatchObject({ reason: "spawn_not_allowed" });
  expect(root.phase).toBe("starting");
});
