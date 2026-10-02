import { expect, it } from "vitest";
import { State, nextDeadline, progress, reduce, start } from "./index.ts";
import { accounts, completion, environment, Harness, spec } from "./test-support.ts";

it.each(["planner", "worker", "reviewer"] as const)(
  "%s tree done without its artifact reaches a user gate at a bounded deadline",
  (role) => {
    const env = environment();
    const h = role === "planner" ? null : new Harness();
    if (role === "reviewer") h?.worker();
    let state =
      h?.state ??
      reduce(start("run", spec(), env).state, { type: "accounts", accounts }, env).state;
    const clock = h?.env ?? env;
    const lane = progress(state).lanes.find((l) => l.role === role);
    if (!lane) throw new Error("Lane missing");
    state = reduce(
      state,
      {
        type: "status",
        laneId: lane.id,
        generation: lane.generation,
        status: "done",
        at: clock.now(),
      },
      clock,
    ).state;
    expect(nextDeadline(state)).toBe(clock.now() + state.spec.constraints.stallAfterMs);
    clock.advance(state.spec.constraints.stallAfterMs);
    state = reduce(state, { type: "tick" }, clock).state;
    expect(progress(state).needsUser).toEqual([
      expect.objectContaining({
        kind: "escalation",
        lane: lane.id,
        message: expect.stringContaining("artifact"),
      }),
    ]);
    expect(progress(state).phase).not.toBe("done");
    expect(nextDeadline(state)).toBeNull();
  },
);

it("repeated done observations cannot extend the missing-artifact deadline", () => {
  const h = new Harness();
  const lane = h.lane("worker");
  const done = () =>
    h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
  done();
  h.env.advance(900);
  done();
  expect(nextDeadline(h.state)).toBe(1100);
  h.env.advance(100);
  h.send({ type: "tick" });
  expect(progress(h.state).needsUser[0]?.message).toContain("artifact");
});

it("a missing-artifact deadline survives restore and an artifact can arrive before it", () => {
  const h = new Harness();
  const lane = h.lane("worker");
  h.send({ type: "status", laneId: lane.id, generation: 0, status: "done", at: h.env.now() });
  h.state = State.parse(JSON.parse(JSON.stringify(h.state)));
  h.env.advance(999);
  h.send({
    type: "artifact",
    laneId: lane.id,
    generation: 0,
    artifact: { kind: "completion", completion: completion() },
  });
  expect(progress(h.state).dag[0]?.state).toBe("reviewing");
  expect(progress(h.state).needsUser).toEqual([]);
});
