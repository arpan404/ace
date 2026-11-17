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

const facts = (input: { host: boolean; market: boolean; fresh: boolean }) => ({
  hostCredential: input.host,
  personOnlyMarket: () => input.market,
  fresh: async () => input.fresh,
});

describe("a person-only market request answered with the host token", () => {
  it("needs a fresh sign-in: the host token may be an agent's", async () => {
    expect(
      await hostAnswerRefusal(
        resolve("ace-cli"),
        facts({ host: true, market: true, fresh: false }),
      ),
    ).toMatchObject({ code: "reauth" });
  });

  it("is answered after a sign-in in the last ten minutes", async () => {
    expect(
      await hostAnswerRefusal(resolve("ace-cli"), facts({ host: true, market: true, fresh: true })),
    ).toBeUndefined();
  });

  it("from the app or a paired device needs nothing more", async () => {
    expect(
      await hostAnswerRefusal(
        resolve("phone-7"),
        facts({ host: false, market: true, fresh: false }),
      ),
    ).toBeUndefined();
  });

  it("other requests aren't held to it", async () => {
    expect(
      await hostAnswerRefusal(
        resolve("ace-cli"),
        facts({ host: true, market: false, fresh: false }),
      ),
    ).toBeUndefined();
  });
});

const write = (input: { key: string; device: string; host: boolean; fresh: boolean }) =>
  settingWriteRefusal(input.key, {
    device: input.device,
    hostCredential: input.host,
    fresh: async () => input.fresh,
  });

it("an agent's device never changes the person's settings", async () => {
  for (const device of ["ace-agent", "ace-reviewer"])
    expect(await write({ key: "beta.marketplace", device, host: true, fresh: true })).toMatchObject(
      { code: "validation" },
    );
});

describe("who may change settings", () => {
  it("Ask me before agents publish needs a fresh sign-in over the host token", async () => {
    const key = "market.askBeforeAgentPublish";
    expect(await write({ key, device: "ace-cli", host: true, fresh: false })).toMatchObject({
      code: "validation",
    });
    expect(await write({ key, device: "ace-cli", host: true, fresh: true })).toBeUndefined();
    expect(await write({ key, device: "desktop-1", host: false, fresh: false })).toBeUndefined();
  });

  it("other settings from the person's devices change as before", async () => {
    expect(
      await write({ key: "logs.maxBytes", device: "ace-cli", host: true, fresh: false }),
    ).toBeUndefined();
  });
});

it("an agent device is ace's own agents and reviewer, never a person's device", () => {
  expect(["ace-agent", "ace-reviewer"].every(isAgentDevice)).toBe(true);
  expect(["ace-cli", "desktop-1", undefined].some(isAgentDevice)).toBe(false);
});
