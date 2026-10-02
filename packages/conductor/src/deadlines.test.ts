import { expect, it } from "vitest";
import { nextDeadline, progress, reduce, start } from "./index.ts";
import { accounts, effectOf, environment, Harness, spec } from "./test-support.ts";

it("the next timer tracks live lane activity, excludes human waits and stops while paused", () => {
  const h = new Harness();
  const lane = h.lane("worker");
  expect(nextDeadline(h.state)).toBe(1100);
  h.env.advance(5);
  h.send({ type: "status", laneId: lane.id, generation: 0, status: "working", at: 105 });
  expect(nextDeadline(h.state)).toBe(1105);
  h.send({ type: "status", laneId: lane.id, generation: 0, status: "waiting", at: 105 });
  expect(nextDeadline(h.state)).toBeNull();
  h.send({ type: "pause" });
  expect(nextDeadline(h.state)).toBeNull();
});
it("deadline gates cannot leave an expired timer spinning", () => {
  const config = spec();
  config.constraints.deadline = 101;
  const h = new Harness(config);
  expect(nextDeadline(h.state)).toBe(101);
  h.env.advance(1);
  h.send({ type: "tick" });
  expect(nextDeadline(h.state)).toBe(1100);
});
it("an unresponsive planner is cancelled before a new planner starts", () => {
  const env = environment();
  let state = start("run", spec(), env).state;
  state = reduce(state, { type: "accounts", accounts }, env).state;
  const planner = progress(state).lanes[0];
  if (!planner) throw new Error("No planner");
  state = reduce(
    state,
    { type: "status", laneId: planner.id, generation: 0, status: "unresponsive", at: env.now() },
    env,
  ).state;
  const gate = progress(state).needsUser[0];
  if (!gate) throw new Error("Missing gate");
  let result = reduce(
    state,
    { type: "approve", approval: { gateId: gate.id, decision: "approve" } },
    env,
  );
  expect(result.effects.some((e) => e.type === "launch")).toBe(false);
  result = reduce(
    result.state,
    { type: "status", laneId: planner.id, generation: 0, status: "done", at: env.now() },
    env,
  );
  expect(effectOf(result.effects, "launch")).toMatchObject({ lane: { role: "planner" } });
});
