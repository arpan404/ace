import { expect, test } from "vitest";
import { canonicalJson, summarize, type TraceCall } from "./trace.ts";

const context = { instructions: "abcd", toolDescriptors: "efgh" };
const call = (tool: string, args: unknown, failed: boolean, native = false): TraceCall => ({
  turn: 1,
  tool,
  args: canonicalJson(args),
  resultText: "",
  failed,
  native,
});

test("a failed call repeated with the same arguments in any key order counts as an identical retry", () => {
  const metrics = summarize(
    context,
    [
      call("thread_control", { title: "x", threadId: "t" }, true),
      call("thread_control", { threadId: "t", title: "x" }, true),
      call("thread_control", { threadId: "t", title: "y" }, false),
    ],
    3,
    true,
  );
  expect(metrics).toMatchObject({ aceCalls: 3, failedCalls: 2, identicalRetries: 1 });
});

test("repeating a successful call is not a retry, and own-tool calls are not ace calls", () => {
  const metrics = summarize(
    context,
    [
      call("context", {}, false),
      call("context", {}, false),
      call("shell", { command: "git branch" }, false, true),
    ],
    2,
    true,
  );
  expect(metrics).toMatchObject({ aceCalls: 2, ownToolCalls: 1, identicalRetries: 0 });
});

test("context tokens grow with instructions, descriptors and call traffic", () => {
  const empty = summarize(context, [], 1, true);
  const busy = summarize(context, [call("context", { a: "x".repeat(400) }, false)], 2, true);
  expect(empty.tokens).toBe(2);
  expect(busy.tokens).toBeGreaterThan(empty.tokens + 100);
});
