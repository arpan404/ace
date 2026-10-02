import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { recover } from "./index.ts";
import { check, complete, fact, setup, stopFact } from "./test-support.ts";

it.each([
  "working",
  "waiting",
  "needs_you",
  "collecting",
  "checking",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
] as const)("a matching start receipt binds a %s lane without regressing its status", (state) => {
  const r = setup("fanout", 1);
  const lane = r.lanes[0];
  if (!lane) throw new Error("Missing lane");
  switch (state) {
    case "working":
      r.send({ type: "thread", ...fact(lane), status: { state, agents: 1 } });
      break;
    case "waiting":
      r.send({ type: "thread", ...fact(lane), status: { state, on: "background_task" } });
      break;
    case "needs_you":
      r.send({ type: "thread", ...fact(lane), status: { state, interactions: 1 } });
      break;
    case "collecting":
      r.send({ type: "thread", ...fact(lane), status: { state: "done" } });
      break;
    case "checking":
      complete(r.state, lane, r.ctx);
      break;
    case "succeeded":
      complete(r.state, lane, r.ctx);
      check(r.state, lane, r.ctx);
      break;
    case "failed":
      r.send({ type: "thread", ...fact(lane), status: { state } });
      break;
    case "cancelling":
      r.send({ type: "cancel" });
      break;
    case "cancelled":
      r.send({ type: "cancel" });
      r.send(stopFact(r.state, lane));
      break;
  }
  const before = lane.phase;
  r.send({ type: "bound", ...fact(lane), threadId: ThreadId.parse("thread"), worktree: "/tree" });
  const recovered = recover(JSON.parse(JSON.stringify(r.state))).state.lanes[lane.id];
  expect(recovered?.threadId).toBe("thread");
  expect(recovered?.worktree).toBe("/tree");
  expect(recovered?.phase).toBe(before);
});

it.each([
  ["other-thread", "/tree"],
  ["thread", "/other-tree"],
  ["other-thread", "/other-tree"],
])(
  "a conflicting binding %s %s is rejected without replacing the owned resources",
  (thread, worktree) => {
    const r = setup("fanout", 1);
    const lane = r.lanes[0];
    if (!lane) throw new Error("Missing lane");
    const binding = {
      type: "bound",
      ...fact(lane),
      threadId: ThreadId.parse("thread"),
      worktree: "/tree",
    } as const;
    r.send(binding);
    const conflict = r.send({ ...binding, threadId: ThreadId.parse(thread), worktree });
    expect(conflict.events).toContainEqual({
      type: "orchestration.rejected",
      orchestrationId: r.state.id,
      runId: r.state.runId,
      reason: "binding_conflict",
    });
    expect(lane.threadId).toBe("thread");
    expect(lane.worktree).toBe("/tree");
    expect(r.send(binding).events).toEqual([]);
  },
);
