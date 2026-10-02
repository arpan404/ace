import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { check, complete, fact, setup } from "./test-support.ts";

it.each(["tokens", "cost", "durationMs"] as const)(
  "exhausting %s cancels live lanes and settles only after stop acknowledgements",
  (budget) => {
    const r = setup("fanout", 2, { [budget]: 10 });
    if (budget === "durationMs") {
      r.ctx.now += 10;
      r.send({ type: "tick" });
    } else {
      const lane = r.lanes[0];
      if (!lane) throw new Error("Missing lane");
      r.send({
        type: "usage",
        ...fact(lane),
        usage: { tokens: budget === "tokens" ? 10 : 0, cost: budget === "cost" ? 10 : 0 },
      });
    }
    expect(r.state.status).toBe("cancelling");
    expect(Object.values(r.state.intents).filter((i) => i.effect.type === "cancel")).toHaveLength(
      2,
    );
    for (const lane of r.lanes) r.send({ type: "stopped", ...fact(lane) });
    expect(r.state.status).toBe("budget_exhausted");
  },
);
it("replayed and decreasing usage counters cannot double-charge the budget", () => {
  const r = setup("fanout", 1, { tokens: 100 });
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  for (const tokens of [70, 70, 20])
    r.send({ type: "usage", ...fact(a), usage: { tokens, cost: 1 } });
  expect(r.state.usage).toEqual({ tokens: 70, cost: 1 });
  expect(r.state.status).toBe("running");
  r.send({ type: "usage", ...fact(a), usage: { tokens: 100, cost: 1 } });
  expect(r.state.status).toBe("cancelling");
});
it("retry keeps cumulative usage, ignores stale attempt facts and stops at the attempt limit", () => {
  const r = setup("fanout", 1, { maxAttempts: 2 });
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  const old = fact(a);
  r.send({ type: "usage", ...old, usage: { tokens: 20, cost: 2 } });
  const retry = r.send({ type: "thread", ...old, status: { state: "failed" } });
  expect(retry.intents[0]?.effect).toMatchObject({ type: "start", attempt: 2 });
  r.send({ type: "usage", ...fact(a), usage: { tokens: 15, cost: 1 } });
  expect(r.state.usage).toEqual({ tokens: 35, cost: 3 });
  r.send({ type: "thread", ...old, status: { state: "done" } });
  r.send({ type: "usage", ...old, usage: { tokens: 9999, cost: 99 } });
  expect(a.phase).toBe("starting");
  expect(r.state.usage.tokens).toBe(35);
  r.send({ type: "thread", ...fact(a), status: { state: "failed" } });
  expect(r.state.status).toBe("failed");
});
it("retry of a review stage preserves its upstream checkpoint artifact", () => {
  const r = setup("pipeline", 2, { maxAttempts: 2 });
  const [a, b] = r.lanes;
  if (!a || !b) throw new Error("Missing lanes");
  complete(r.state, a, r.ctx);
  const next = check(r.state, a, r.ctx).intents[0];
  const retry = r.send({ type: "thread", ...fact(b), status: { state: "failed" } }).intents[0];
  expect(next?.effect.type === "start" && next.effect.input).toEqual(
    retry?.effect.type === "start" && retry.effect.input,
  );
  expect(retry?.effect).toMatchObject({ attempt: 2 });
});
it("cancelling before start acknowledgement still stops the owned thread when it binds late", () => {
  const r = setup("fanout", 1);
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  r.send({ type: "cancel" });
  r.send({
    type: "bound",
    ...fact(a),
    threadId: ThreadId.parse("late-thread"),
    worktree: "/late-worktree",
  });
  expect(a.phase).toBe("cancelling");
  expect(r.state.status).toBe("cancelling");
  r.send({ type: "stopped", ...fact(a) });
  expect(r.state.status).toBe("cancelled");
});

it("late final usage still marks an over-budget result as exhausted", () => {
  const r = setup("fanout", 1, { tokens: 10 });
  const a = r.lanes[0];
  if (!a) throw new Error("Missing lane");
  complete(r.state, a, r.ctx);
  check(r.state, a, r.ctx);
  expect(r.state.status).toBe("succeeded");
  r.send({ type: "usage", ...fact(a), usage: { tokens: 10, cost: 0 } });
  expect(r.state.status).toBe("budget_exhausted");
});
