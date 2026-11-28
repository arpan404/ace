import type { AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { compactRefusal } from "./context-compact.ts";

test("an idle root, or one whose model has handed off to background work, can compact", () => {
  const free: (AgentStatus | undefined)[] = [
    undefined,
    { state: "idle" },
    { state: "interrupted" },
    { state: "blocked", on: "background_task", refs: [] },
    { state: "blocked", on: "subagents", refs: [] },
  ];
  for (const status of free) expect(compactRefusal(status)).toBeUndefined();
});

test("a root compacting now says so, and a turn or a question in progress asks to wait", () => {
  expect(compactRefusal({ state: "working", activity: "compacting" })).toBe("Compacting now");
  expect(compactRefusal({ state: "working", activity: "responding" })).toBe(
    "Wait for this turn to finish",
  );
  expect(compactRefusal({ state: "blocked", on: "human", refs: [] })).toBe(
    "Wait for this turn to finish",
  );
});
