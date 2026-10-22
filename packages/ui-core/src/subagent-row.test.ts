import { expect, test } from "vitest";
import { subagentDetail, subagentElapsed, subagentMeta, subagentSpan } from "./subagent-row.ts";

const working = { status: { state: "working", activity: "tool", itemId: "i1" } } as const;

test("a working subagent's second line names the step it runs, only while facts are fresh", () => {
  const entry = { state: "working", agentId: "a1" } as const;
  expect(subagentDetail(entry, working, "Read row-parts.tsx", true)).toEqual({
    detail: "Read row-parts.tsx",
    kind: "live",
  });
  expect(subagentDetail(entry, working, "Read row-parts.tsx", false)).toEqual({});
});

test("a subagent waiting on the person says so, whatever its own agent reports", () => {
  expect(subagentDetail({ state: "human", agentId: "a1" }, working, "Edit", true)).toEqual({
    detail: "Waiting for you",
    kind: "human",
  });
});

test("a failed subagent's line is its error's title, else its result", () => {
  const failed = {
    status: { state: "failed", error: { kind: "quota", message: "429", title: "Usage limit" } },
  } as const;
  expect(subagentDetail({ state: "failed", agentId: "a1" }, failed, undefined, true)).toEqual({
    detail: "Usage limit",
    kind: "failed",
  });
  expect(
    subagentDetail(
      { state: "failed", agentId: "a1", result: "Crashed" },
      undefined,
      undefined,
      true,
    ),
  ).toEqual({ detail: "Crashed", kind: "failed" });
});

test("a finished subagent shows what it found", () => {
  expect(
    subagentDetail(
      { state: "done", agentId: "a1", result: "Found 3 races" },
      undefined,
      undefined,
      true,
    ),
  ).toEqual({ detail: "Found 3 races", kind: "result" });
});

test("a delegated thread's meta names it delegated, with its model and effort", () => {
  expect(
    subagentMeta({ childThreadId: "t2" }, { model: "gpt-5.5", options: { effort: "high" } }),
  ).toBe("Delegated · GPT-5.5 · High");
  expect(subagentMeta({})).toBeUndefined();
});

test("a group keeps running, with no end, while any subagent still works", () => {
  const span = subagentSpan([
    { state: "done", startedAt: 1_000, endedAt: 5_000 },
    { state: "working", startedAt: 2_000 },
  ]);
  expect(span).toEqual({ running: true, startedAt: 1_000, endedAt: undefined });
  expect(subagentElapsed(span, true)).toEqual({ since: 1_000 });
  expect(subagentElapsed(span, false)).toBeUndefined();
});

test("a settled group's time runs from its first launch to its last end", () => {
  const span = subagentSpan([
    { state: "done", startedAt: 1_000, endedAt: 5_000 },
    { state: "failed", startedAt: 2_000, endedAt: 8_000 },
  ]);
  expect(subagentElapsed(span, false)).toEqual({ text: "7s" });
  expect(
    subagentElapsed({ running: false, startedAt: 1_000, endedAt: 1_400 }, true),
  ).toBeUndefined();
});
