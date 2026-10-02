import { expect, test } from "vitest";
import { recover, spawnAgent } from "./index.ts";
import { check, complete, fact, setup } from "./test-support.ts";

function spawned() {
  const r = setup("coordinator", 1, { maxAttempts: 2 });
  const root = r.lanes[0];
  if (!root) throw new Error("Missing planner");
  const caller = fact(root);
  const request = { requestId: "req", spec: root.spec, prompt: "Subtask" };
  const result = spawnAgent(r.state, caller, request, r.ctx);
  const child = result.laneId ? r.state.lanes[result.laneId] : undefined;
  if (!child) throw new Error("Missing child");
  return { ...r, root, child, caller, request, key: `${root.id}:1:req` };
}

test("recovered spawn replay returns the existing child without starting another thread", () => {
  const r = spawned();
  const recovered = recover(JSON.parse(JSON.stringify(r.state)));
  const result = spawnAgent(recovered.state, r.caller, r.request, r.ctx);
  expect(result.laneId).toBe(r.child.id);
  expect(result.intents).toEqual([]);
  expect(recovered.intents.filter((intent) => intent.effect.laneId === r.child.id)).toMatchObject([
    { effect: { type: "start", laneId: r.child.id, attempt: 1 } },
  ]);
  expect(Object.values(recovered.state.lanes).map((lane) => lane.id)).toEqual([
    r.root.id,
    r.child.id,
  ]);
});

test("recovery preserves old spawn receipts when the parent retries and separates the new attempt", () => {
  const r = spawned();
  complete(r.state, r.child, r.ctx);
  check(r.state, r.child, r.ctx);
  r.send({ type: "thread", ...fact(r.root), status: { state: "failed" } });
  expect(r.root.attempt).toBe(2);
  const recovered = recover(JSON.parse(JSON.stringify(r.state)));
  expect(spawnAgent(recovered.state, r.caller, r.request, r.ctx).laneId).toBe(r.child.id);
  const newAttempt = spawnAgent(recovered.state, fact(r.root), r.request, r.ctx);
  expect(newAttempt.laneId).toBeDefined();
  expect(newAttempt.laneId).not.toBe(r.child.id);
  expect(newAttempt.intents).toMatchObject([{ effect: { type: "start" } }]);
  expect(recover(recovered.state).state.open).toBe(2);
});

test("recovery refuses a spawn receipt pointing to a nonexistent child or a root", () => {
  const r = spawned();
  for (const childId of ["nonexistent", r.root.id]) {
    expect(() => recover({ ...r.state, spawnReceipts: { [r.key]: childId } })).toThrow(
      "Invalid spawn receipt",
    );
  }
});

test("recovery refuses a child receipt assigned to a different parent", () => {
  const r = spawned();
  const nested = spawnAgent(r.state, fact(r.child), { ...r.request, requestId: "nested" }, r.ctx);
  if (!nested.laneId) throw new Error("Missing nested child");
  expect(() =>
    recover({
      ...r.state,
      spawnReceipts: {
        [r.key]: nested.laneId,
        [`${r.child.id}:1:nested`]: r.child.id,
      },
    }),
  ).toThrow("Invalid spawn receipt");
});

test.each(["0", "3", "01", "1.0", "NaN"])(
  "recovery refuses a noncanonical or unavailable parent attempt %s",
  (attempt) => {
    const r = spawned();
    expect(() =>
      recover({
        ...r.state,
        spawnReceipts: { [`${r.root.id}:${attempt}:req`]: r.child.id },
      }),
    ).toThrow("Invalid spawn receipt");
  },
);

test.each(["", "bad:request", "constructor"])(
  "recovery refuses a malformed request identity %j",
  (requestId) => {
    const r = spawned();
    expect(() =>
      recover({
        ...r.state,
        spawnReceipts: { [`${r.root.id}:1:${requestId}`]: r.child.id },
      }),
    ).toThrow("Invalid spawn receipt");
  },
);

test("recovery refuses missing parent identity and multiple receipts for one child", () => {
  const r = spawned();
  expect(() =>
    recover({
      ...r.state,
      spawnReceipts: { [`missing:1:req`]: r.child.id },
    }),
  ).toThrow("Invalid spawn receipt");
  expect(() =>
    recover({
      ...r.state,
      spawnReceipts: { ...r.state.spawnReceipts, [`${r.root.id}:1:other`]: r.child.id },
    }),
  ).toThrow("Invalid spawn receipt");
});

test("recovery refuses a spawned child whose replay receipt was lost", () => {
  const r = spawned();
  expect(() => recover({ ...r.state, spawnReceipts: {} })).toThrow("Missing spawn receipt");
});
