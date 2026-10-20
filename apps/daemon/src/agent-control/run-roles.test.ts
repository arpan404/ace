import { expect, test } from "vitest";
import { DelegationTask } from "@ace/protocol";
import type { RoleChoice } from "@ace/settings/roles";
import { roleTask } from "./run-roles.ts";

const verify: RoleChoice = { provider: "claude", model: "opus", effort: "high", tier: "priority" };
const task = (fields: Partial<DelegationTask> = {}) =>
  DelegationTask.parse({ requestId: "r1", task: "Check it", role: "check-it", ...fields });
const lookup = (role: string) => (role === "verify" ? verify : undefined);

test("a task without its own choice runs as the role's provider, model, effort and tier", () => {
  expect(roleTask(task({ runRole: "verify" }), lookup).task).toMatchObject({
    provider: "claude",
    model: "opus",
    effort: "high",
    options: { serviceTier: "priority" },
  });
});

test("a provider or model on the task wins over the whole role, and its own effort wins", () => {
  const own = roleTask(task({ runRole: "verify", provider: "codex" }), lookup).task;
  expect(own).toMatchObject({ provider: "codex" });
  expect(own).not.toHaveProperty("model");
  expect(own).not.toHaveProperty("effort");
  expect(roleTask(task({ runRole: "verify", effort: "low" }), lookup).task).toMatchObject({
    provider: "claude",
    effort: "low",
  });
});

test("an unset role is refused with where the person sets it, never filled from the caller", () => {
  expect(() => roleTask(task({ runRole: "review" }), lookup)).toThrow(
    expect.objectContaining({ publicDetail: expect.stringContaining("Settings → Roles") }),
  );
  // A task that chose its own provider does not need the role.
  expect(roleTask(task({ runRole: "review", provider: "codex" }), lookup).task).toMatchObject({
    provider: "codex",
  });
});

test("runRole never reaches the delegation request", () => {
  expect(roleTask(task({ runRole: "verify" }), lookup).task).not.toHaveProperty("runRole");
});
