import { expect, test } from "vitest";
import { codexShellEnvConfig } from "./shell-env.ts";

test("each agent variable is its own shell_environment_policy.set override, so the person's own entries stay", () => {
  expect(
    codexShellEnvConfig({ ACE_THREAD_ID: "t_1", ACE_NO_INPUT: "1", ACE_HOME: "/h/.ace" }),
  ).toEqual({
    "shell_environment_policy.set.ACE_THREAD_ID": "t_1",
    "shell_environment_policy.set.ACE_NO_INPUT": "1",
    "shell_environment_policy.set.ACE_HOME": "/h/.ace",
  });
});

test("a session without agent variables adds no overrides", () => {
  expect(codexShellEnvConfig(undefined)).toEqual({});
});

test("a name that would split the dotted config path is left out", () => {
  expect(codexShellEnvConfig({ "A.B": "x", ok_lower: "y" })).toEqual({});
});
