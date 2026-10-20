import { expect, test } from "vitest";
import { applyRole, type RoleTask } from "./index.ts";

const verify = {
  selection: { provider: "claude" as const, model: "opus", effort: "high" },
  source: "run" as const,
};

test("a task without its own choice takes the role's provider, model and effort", () => {
  const task: RoleTask & { task: string } = { task: "check" };
  expect(applyRole(task, verify)).toEqual({
    task: "check",
    provider: "claude",
    model: "opus",
    effort: "high",
  });
});

test("a provider or model on the task wins over the role, and so does its effort", () => {
  expect(applyRole({ provider: "codex" as const }, verify)).toEqual({ provider: "codex" });
  expect(applyRole({ model: "gpt-5" }, verify)).toEqual({ model: "gpt-5" });
  expect(applyRole({ effort: "low" }, verify)).toEqual({
    provider: "claude",
    model: "opus",
    effort: "low",
  });
});

test("an effort-only role still sets the effort of a task that chose its provider", () => {
  const effortOnly = { selection: { effort: "xhigh" }, source: "project" as const };
  expect(applyRole({ provider: "codex" as const }, effortOnly)).toEqual({
    provider: "codex",
    effort: "xhigh",
  });
  expect(applyRole({ provider: "codex" as const }, undefined)).toEqual({ provider: "codex" });
});
