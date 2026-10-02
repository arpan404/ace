import { expect, it } from "vitest";
import { artifact, check, complete, fact, setup } from "./test-support.ts";
const orders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

it("fanout outcome remains correct for every three-lane completion order and success/failure combination", () => {
  for (const order of orders)
    for (let mask = 0; mask < 8; mask++) {
      const r = setup();
      for (const index of order) {
        const lane = r.lanes[index];
        if (!lane) throw new Error("Missing lane");
        if (mask & (1 << index)) {
          complete(r.state, lane, r.ctx);
          check(r.state, lane, r.ctx);
        } else r.send({ type: "thread", ...fact(lane), status: { state: "failed" } });
      }
      expect(r.state.status, `${order}/${mask}`).toBe(mask ? "succeeded" : "failed");
    }
});
it("race chooses the first passing result for every completion order and waits for all cancellations", () => {
  for (const order of orders)
    for (let mask = 0; mask < 8; mask++) {
      const r = setup("race");
      let expectedWinner: string | undefined;
      for (const index of order) {
        const lane = r.lanes[index];
        if (!lane) throw new Error("Missing lane");
        if (lane.phase === "cancelling") {
          expect(r.state.status).toBe("cancelling");
          r.send({ type: "stopped", ...fact(lane) });
        } else {
          complete(r.state, lane, r.ctx);
          check(r.state, lane, r.ctx, Boolean(mask & (1 << index)));
          if (mask & (1 << index) && !expectedWinner) expectedWinner = lane.id;
        }
      }
      expect(r.state.winner, `${order}/${mask}`).toBe(expectedWinner);
      expect(r.state.status, `${order}/${mask}`).toBe(mask ? "succeeded" : "failed");
    }
});
it("pipeline stages instruct implementation, review and fixing instead of repeating implementation", () => {
  const r = setup("pipeline");
  expect(r.lanes.map((l) => l.prompt.split("\n")[0])).toEqual([
    "Implement the task. Return a checkpoint, summary and test results.",
    "Review the input checkpoint and test results. Return a checkpoint and a summary of issues for the fix stage.",
    "Fix the issues in the input review artifact. Return a checkpoint, summary and test results.",
  ]);
  expect(r.lanes.every((l) => l.prompt.includes(r.input.prompt))).toBe(true);
});
it("oversized artifacts are rejected without ending a live thread or emitting check work", () => {
  const r = setup("fanout", 1);
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  expect(() =>
    r.send({ type: "artifact", ...fact(a), artifact: { ...artifact, summary: "x".repeat(8193) } }),
  ).toThrow();
  expect(r.state.status).toBe("running");
  expect(a.phase).toBe("starting");
  expect(Object.values(r.state.intents).map((i) => i.effect.type)).toEqual(["start"]);
});
