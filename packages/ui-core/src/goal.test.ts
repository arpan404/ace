import { expect, test } from "vitest";
import { goalUsage, parseGoalCommand } from "./goal.ts";

test("/goal sets an objective, and pause, resume and clear change the goal instead", () => {
  expect(parseGoalCommand("/goal all tests in packages/api pass")).toEqual({
    objective: "all tests in packages/api pass",
  });
  expect(parseGoalCommand("  /goal  Pause ")).toEqual({ status: "paused" });
  expect(parseGoalCommand("/goal resume")).toEqual({ status: "active" });
  expect(parseGoalCommand("/goal clear")).toBe("clear");
  expect(parseGoalCommand("/goal ship it\nwith release notes")).toEqual({
    objective: "ship it\nwith release notes",
  });
});

test("anything that isn't a /goal command with words after it is sent as a message", () => {
  for (const text of ["/goal", "/goal   ", "/goals are good", "set a /goal please", "/goalie"])
    expect(parseGoalCommand(text)).toBeUndefined();
});

test("a goal's usage says only what the provider reported", () => {
  expect(
    goalUsage({
      objective: "x",
      status: "active",
      tokensUsed: 120_000,
      tokenBudget: 500_000,
      timeUsedSeconds: 842,
      checks: 1,
    }),
  ).toBe("120K / 500K tokens · 14m 2s · 1 check");
  expect(
    goalUsage({ objective: "x", status: "active", tokensUsed: 900, timeUsedSeconds: 30 }),
  ).toBe("900 tokens");
  expect(goalUsage({ objective: "x", status: "paused" })).toBeUndefined();
});
