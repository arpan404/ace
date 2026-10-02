import { afterEach, expect, test } from "vitest";
import type { Fact } from "@ace/core";
import type { InteractionResolution } from "@ace/protocol";
import { harness, scriptFrames, start } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const question: Fact = {
  type: "interaction.opened",
  agent: "root",
  interaction: "questions",
  blocking: true,
  request: {
    kind: "question",
    questions: [
      {
        id: "one",
        text: "Choose one",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        multiSelect: false,
        allowOther: false,
      },
      {
        id: "many",
        text: "Choose several",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        multiSelect: true,
        allowOther: true,
      },
    ],
  },
};
const invalid: InteractionResolution[] = [
  { kind: "approval", optionId: "a" },
  { kind: "question", answers: { one: ["a"], unknown: ["a"] } },
  { kind: "question", answers: { one: ["invented"], many: ["a"] } },
  { kind: "question", answers: { one: ["a", "b"], many: ["a"] } },
  { kind: "question", answers: { one: ["a"], many: ["a", "a"] } },
  { kind: "question", answers: { one: ["a"], many: [""] } },
  { kind: "question", answers: { one: ["a"] } },
  { kind: "question", answers: { one: [], many: ["a"] } },
  { kind: "question", answers: { one: ["a"], many: ["a"] }, dismissed: true },
];
test.each(invalid)(
  "invalid question answers do not reserve the valid response: %j",
  async (resolution) => {
    const frames = scriptFrames();
    const h = await harness(
      [{ on: "send", frames: [frames.frame(start, question)] }, { on: "resolve" }],
      frames,
    );
    cleanups.push(h.close);
    const threadId = await h.create();
    const view = h.store.snapshotThread(threadId);
    const interactionId = Object.values(view.interactions)[0]?.id;
    if (!interactionId) throw new Error("Missing question");
    expect(h.command({ type: "interaction.resolve", interactionId, resolution }).error).toBe(
      "invalid_resolution",
    );
    const valid: InteractionResolution = {
      kind: "question",
      answers: { one: ["a"], many: ["a", "free text"] },
    };
    expect(h.command({ type: "interaction.resolve", interactionId, resolution: valid }).ok).toBe(
      true,
    );
    await h.engine.flush();
    expect(h.adapter.commands.filter((c) => c.type === "resolve")).toEqual([
      { type: "resolve", interaction: "questions", resolution: valid },
    ]);
  },
);

test("a dismissed question is delivered without answers", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [{ on: "send", frames: [frames.frame(start, question)] }, { on: "resolve" }],
    frames,
  );
  cleanups.push(h.close);
  const threadId = await h.create();
  const view = h.store.snapshotThread(threadId);
  const interactionId = Object.values(view.interactions)[0]?.id;
  if (!interactionId) throw new Error("Missing question");
  const resolution = { kind: "question" as const, answers: {}, dismissed: true };
  expect(h.command({ type: "interaction.resolve", interactionId, resolution }).ok).toBe(true);
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toEqual({
    type: "resolve",
    interaction: "questions",
    resolution,
  });
});
