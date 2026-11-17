import { describe, expect, it } from "vitest";
import { toCliError } from "./errors.ts";
import { agentShell, localDevice, personOnlyRefusal, typedConfirms } from "./person-gate.ts";

describe("an agent's shell", () => {
  it.each([
    [{ ACE_THREAD_ID: "t_1" }, true],
    [{ ACE_NO_INPUT: "1" }, true],
    [{ ACE_NO_INPUT: "true" }, true],
    [{ ACE_NO_INPUT: "0" }, false],
    [{ ACE_THREAD_ID: "  " }, false],
    [{}, false],
  ])("%o is an agent's: %s", (env, agent) => {
    expect(agentShell(env)).toBe(agent);
  });
});

describe("what the CLI keeps for the person", () => {
  it.each(["answer", "setting"] as const)("an agent can't %s, terminal or not", (kind) => {
    for (const interactive of [true, false])
      expect(toCliError(personOnlyRefusal(kind, { agent: true, interactive }))).toMatchObject({
        status: "needs-human",
        code: "person_only",
      });
  });

  it("a person answers only at a terminal", () => {
    expect(
      toCliError(personOnlyRefusal("answer", { agent: false, interactive: false })),
    ).toMatchObject({ status: "needs-human", code: "confirm" });
    expect(personOnlyRefusal("answer", { agent: false, interactive: true })).toBeUndefined();
  });

  it("a person changes settings from a script as before", () => {
    expect(personOnlyRefusal("setting", { agent: false, interactive: false })).toBeUndefined();
  });
});

it("in an agent's shell the CLI is ace-agent to the daemon, with its own outbox", () => {
  expect(localDevice(true)).toEqual({ id: "ace-agent", outbox: "cli-agent" });
  expect(localDevice(false)).toEqual({ id: "ace-cli", outbox: "" });
});

describe("a typed confirmation", () => {
  it.each([
    ["allow", true],
    [" Allow ", true],
    ["", false],
    [undefined, false],
    ["y", false],
    ["yes", false],
    ["allow it", false],
  ])("typing %j confirms allow: %s", (typed, confirms) => {
    expect(typedConfirms("allow", typed)).toBe(confirms);
  });
});
