import { expect, it } from "vitest";
import {
  subagentGroupCounts,
  subagentGroupStatus,
  subagentGroupTitle,
  subagentStatusCounts,
  subagentStatusLine,
} from "./index.ts";
import type { RunAgent } from "./agent-runs.ts";
import { subagentBranchStates } from "./subagents.ts";

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

const countWords = (states: Parameters<typeof subagentGroupCounts>[0]) =>
  subagentGroupCounts(states).map((part) => `${part.count} ${part.word}`);

it("a launch says it ran only once every child has ended, and then counts only what didn't finish", () => {
  expect(subagentGroupTitle(["done"])).toBe("1 subagent ran");
  expect(subagentGroupTitle(["done", "failed", "cancelled"])).toBe("3 subagents ran");
  expect(countWords(["done", "failed", "cancelled"])).toEqual(["1 failed", "1 cancelled"]);
  expect(countWords(["done", "done"])).toEqual([]);
  // Still working, waiting, not responding or waiting on the person: never "ran".
  for (const open of ["working", "waiting", "unresponsive", "human"] as const) {
    expect(subagentGroupTitle(["done", open])).toBe("2 subagents");
    expect(countWords(["done", open])).toContain("1 done");
  }
  expect(subagentGroupTitle([])).toBe("0 subagents");
});

it("the live line never counts a subagent working while it only waits on a limit-held child", () => {
  const agent = (id: string, parentId: string | null, status: RunAgent["status"]): RunAgent => ({
    id,
    origin: parentId === null ? "root" : "provider_subagent",
    parentId,
    native: { provider: "claude", nativeId: id },
    status,
    createdAt: 1,
    spawnedBy: parentId === null ? undefined : `spawn-${id}`,
  });
  const agents = [
    agent("root", null, { state: "blocked", on: "subagents", refs: ["review"] }),
    agent("review", "root", { state: "blocked", on: "subagents", refs: ["nested"] }),
    agent("nested", "review", { state: "blocked", on: "rate_limit", refs: [] }),
  ];
  const work = { running: new Set(["root", "review", "nested"]), needsYou: new Set<string>() };
  expect(subagentBranchStates(agents, work)).toEqual(["waiting"]);
  const busy = agents.map((entry) =>
    entry.id === "nested"
      ? { ...entry, status: { state: "working", activity: "tool" } as const }
      : entry,
  );
  expect(subagentBranchStates(busy, work)).toEqual(["working"]);
});
