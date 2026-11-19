import { expect, test } from "vitest";
import { machineStatusThreads } from "./status-result.ts";

const view = (threadId: string, failure?: unknown) => ({
  threadId,
  state: "failed",
  title: "Review",
  elapsedSeconds: 3,
  status: { state: "failed" },
  requests: [],
  result: "Stopped.",
  ...(failure === undefined ? {} : { failure }),
});

test("a failure code this build doesn't know arrives as it was sent", () => {
  const [thread] = machineStatusThreads({
    threads: [view("machine-a", { code: "context_overflow", message: "Too long." })],
  });
  expect(thread?.failure).toEqual({ code: "context_overflow", message: "Too long." });
});

test("an unreadable failure drops from its own child only; the rest of the batch still arrives", () => {
  const threads = machineStatusThreads({
    threads: [
      view("machine-a", { code: "usage_limited", message: "" }),
      view("machine-b", { code: "usage_limited", message: "Usage limit reached." }),
    ],
  });
  expect(threads.map((thread) => [thread.threadId, thread.state, thread.result])).toEqual([
    ["machine-a", "failed", "Stopped."],
    ["machine-b", "failed", "Stopped."],
  ]);
  expect(threads[0]?.failure).toBeUndefined();
  expect(threads[1]?.failure?.message).toBe("Usage limit reached.");
});

test("an answer broken outside its failures is still refused", () => {
  expect(() => machineStatusThreads({ threads: [{ threadId: "machine-a" }] })).toThrow();
});
