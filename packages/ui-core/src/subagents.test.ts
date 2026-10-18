import { expect, it } from "vitest";
import { subagentGroupStatus, subagentStatusCounts, subagentStatusLine } from "./index.ts";

it("a group that needs you reads needs you whatever else its children are doing", () => {
  expect(subagentGroupStatus(["done", "failed", "working", "human"])).toBe("human");
});

it("a failed child outranks working and done ones", () => {
  expect(subagentGroupStatus(["done", "working", "failed"])).toBe("failed");
  expect(subagentGroupStatus(["done", "unresponsive"])).toBe("failed");
});

it("a group never reads done while any child still works or waits", () => {
  expect(subagentGroupStatus(["done", "done", "working"])).toBe("working");
  expect(subagentGroupStatus(["done", "waiting"])).toBe("working");
  expect(subagentGroupStatus(["done", "cancelled"])).toBe("done");
});

it("a group whose children are not yet seen is still working", () => {
  expect(subagentGroupStatus([])).toBe("working");
});

it("status counts come worst first, one part per state, matching the status line", () => {
  const states = ["done", "working", "working", "failed"] as const;
  expect(subagentStatusCounts(states).map((part) => [part.state, part.count])).toEqual([
    ["working", 2],
    ["failed", 1],
    ["done", 1],
  ]);
  expect(subagentStatusLine(states)).toBe("2 working · 1 failed · 1 done");
});
