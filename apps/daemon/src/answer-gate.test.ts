import { describe, expect, it } from "vitest";
import { Command, type Interaction } from "@ace/protocol";
import {
  agentAnswerRefusal,
  hostAnswerRefusal,
  isAgentDevice,
  settingWriteRefusal,
} from "./answer-gate.ts";

const resolve = (deviceId: string, kind: "approval" | "question" = "approval") =>
  Command.parse({
    id: "cmd-1",
    deviceId,
    payload: {
      type: "interaction.resolve",
      interactionId: "int-1",
      resolution:
        kind === "approval"
          ? { kind: "approval", optionId: "yes" }
          : { kind: "question", answers: { q1: ["yes"] } },
    },
  });
const kinds = (kind: Interaction["request"]["kind"] | undefined) => () => kind;

describe("agents never answer the person's requests", () => {
  it.each(["approval", "plan_review", "elicitation", "browser_help"] as const)(
    "an agent device's answer to a provider's %s is refused",
    (kind) => {
      for (const device of ["ace-agent", "ace-reviewer"])
        expect(agentAnswerRefusal(resolve(device), kinds(kind))).toMatchObject({
          ok: false,
          error: "human_answer_required",
        });
    },
  );

  it("a person's device answers as before", () => {
    for (const device of ["ace-cli", "desktop-1", "phone-7"])
      expect(agentAnswerRefusal(resolve(device), kinds("approval"))).toBeUndefined();
  });

  it("a parent agent may still answer its own child's question (question_answer)", () => {
    expect(agentAnswerRefusal(resolve("ace-agent", "question"), kinds("question"))).toBeUndefined();
  });

  it("anything that isn't an answer passes", () => {
    const send = Command.parse({
      id: "cmd-2",
      deviceId: "ace-agent",
      payload: { type: "thread.interrupt", threadId: "t-1" },
    });
    expect(agentAnswerRefusal(send, kinds("approval"))).toBeUndefined();
  });
});

const facts = (input: { host: boolean; market: boolean }) => ({
  unproven: input.host,
  personOnlyMarket: () => input.market,
});

describe("a person-only market request", () => {
  it("is never answered from a socket that hasn't proved the person, however lately anyone signed in", async () => {
    expect(
      await hostAnswerRefusal(resolve("ace-cli"), facts({ host: true, market: true })),
    ).toMatchObject({ code: "reauth" });
  });

  it("is answered from a socket that proved the person's standing", async () => {
    expect(
      await hostAnswerRefusal(resolve("phone-7"), facts({ host: false, market: true })),
    ).toBeUndefined();
  });

  it("other requests aren't held to it", async () => {
    expect(
      await hostAnswerRefusal(resolve("ace-cli"), facts({ host: true, market: false })),
    ).toBeUndefined();
  });
});

const write = (input: { key: string; device: string; host: boolean }) =>
  settingWriteRefusal(input.key, { device: input.device, unproven: input.host });

it("an agent's device never changes the person's settings", async () => {
  for (const device of ["ace-agent", "ace-reviewer"])
    expect(await write({ key: "beta.marketplace", device, host: false })).toMatchObject({
      code: "validation",
    });
});

describe("who may change settings", () => {
  it("Ask me before agents publish changes only from a socket that proved the person", async () => {
    const key = "market.askBeforeAgentPublish";
    expect(await write({ key, device: "ace-cli", host: true })).toMatchObject({
      code: "validation",
    });
    expect(await write({ key, device: "desktop-1", host: false })).toBeUndefined();
  });

  it("other settings from the person's devices change as before", async () => {
    expect(await write({ key: "logs.maxBytes", device: "ace-cli", host: true })).toBeUndefined();
  });
});

it("an agent device is ace's own agents and reviewer, never a person's device", () => {
  expect(["ace-agent", "ace-reviewer"].every(isAgentDevice)).toBe(true);
  expect(["ace-cli", "desktop-1", undefined].some(isAgentDevice)).toBe(false);
});
