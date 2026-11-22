import { expect, test } from "vitest";
import { EarlyActions } from "./early-actions.ts";

test("actions sent before the client exists come back in the order they were sent", () => {
  const early = new EarlyActions();
  const sent = [
    { type: "open", threadId: "a", epoch: 1 },
    { type: "thread.shown", threadId: "a", epoch: 1 },
    { type: "retry" },
    { type: "sheet", action: { kind: "agents", open: true } },
  ];
  for (const action of sent) expect(early.hold(action)).toBe(true);
  expect(early.take()).toEqual(sent);
  expect(early.take()).toEqual([]);
});

test("only the latest open of each thread is kept, in its own place", () => {
  const early = new EarlyActions();
  early.hold({ type: "open", threadId: "a", epoch: 1 });
  early.hold({ type: "open", threadId: "b", epoch: 2 });
  early.hold({ type: "open", threadId: "a", epoch: 3 });
  expect(early.take()).toEqual([
    { type: "open", threadId: "b", epoch: 2 },
    { type: "open", threadId: "a", epoch: 3 },
  ]);
});

test("a command and the read-ahead switch are not held: they answer at once", () => {
  const early = new EarlyActions();
  expect(early.hold({ type: "command", requestId: "r", payload: {} })).toBe(false);
  expect(early.hold({ type: "readAhead", allowed: true })).toBe(false);
  expect(early.hold("not an action")).toBe(false);
  expect(early.take()).toEqual([]);
});

test("past its bound the oldest action goes before any open", () => {
  const early = new EarlyActions(2);
  early.hold({ type: "open", threadId: "a", epoch: 1 });
  early.hold({ type: "network", online: true });
  early.hold({ type: "wake" });
  expect(early.take()).toEqual([{ type: "open", threadId: "a", epoch: 1 }, { type: "wake" }]);
});
