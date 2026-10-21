import { expect, it } from "vitest";
import { harness } from "./test-helper.ts";

it("omitted question booleans canonicalize to explicit false in emitted, stored and client views", () => {
  const h = harness();
  h.see();
  h.start();
  const events = h.send({
    type: "interaction.opened",
    agent: "root",
    interaction: "q-defaults",
    blocking: true,
    request: {
      kind: "question",
      questions: [{ id: "q", text: "Continue?", options: [] }],
    },
  });
  const opened = events.find((event) => event.type === "interaction.opened");
  expect(opened?.type).toBe("interaction.opened");
  if (opened?.type !== "interaction.opened") throw new Error("Expected interaction.opened");
  expect(opened.interaction.request).toMatchObject({
    kind: "question",
    questions: [{ id: "q", secret: false, multiSelect: false, allowOther: false }],
  });
  expect(h.state.interactions["q-defaults"]?.request).toMatchObject({
    kind: "question",
    questions: [{ id: "q", secret: false, multiSelect: false, allowOther: false }],
  });
  expect(h.view.interactions[opened.interaction.id]?.request).toMatchObject({
    kind: "question",
    questions: [{ id: "q", secret: false, multiSelect: false, allowOther: false }],
  });
});

it("explicit secret:true survives in emitted, stored and client views", () => {
  const h = harness();
  h.see();
  h.start();
  const events = h.send({
    type: "interaction.opened",
    agent: "root",
    interaction: "q-secret",
    blocking: true,
    request: {
      kind: "question",
      questions: [{ id: "token", text: "Token?", options: [], secret: true }],
    },
  });
  const opened = events.find((event) => event.type === "interaction.opened");
  if (opened?.type !== "interaction.opened") throw new Error("Expected interaction.opened");
  expect(opened.interaction.request).toMatchObject({
    kind: "question",
    questions: [{ id: "token", secret: true }],
  });
  expect(h.state.interactions["q-secret"]?.request).toMatchObject({
    kind: "question",
    questions: [{ id: "token", secret: true }],
  });
  expect(h.view.interactions[opened.interaction.id]?.request).toMatchObject({
    kind: "question",
    questions: [{ id: "token", secret: true }],
  });
});
