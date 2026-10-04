import { expect, test } from "vitest";
import { setup } from "./translator.test-helper.ts";

function remember(
  h: ReturnType<typeof setup>,
  threadId = "native",
  interactionId = "interaction-1",
) {
  h.feed({
    seq: 99,
    t: 99,
    dir: "note",
    channel: "stdio",
    data: {
      event: "interaction-answer",
      threadId,
      interaction: "async:q",
      interactionId,
      text: "Tabs",
    },
  });
}
const echo = (id: string, text = "Tabs") => ({
  type: "userMessage",
  id,
  content: [{ type: "text", text }],
});
test("an answer echo keeps its interaction identity on completion and consumes exactly one match", () => {
  const h = setup();
  remember(h);
  h.item(echo("person", "Unrelated"), true);
  h.item(echo("answer"));
  h.item(echo("answer"), true);
  h.item(echo("later-person"), true);
  expect(h.state.items["answer"]).toMatchObject({
    synthetic: true,
    origin: { kind: "interaction_answer", interactionId: "interaction-1" },
  });
  expect(h.state.items["person"]).not.toHaveProperty("origin");
  expect(h.state.items["later-person"]).not.toHaveProperty("origin");
});
test("an equal message on a child thread does not consume the root's answer", () => {
  const h = setup();
  h.recv("thread/started", { thread: { id: "child", parentThreadId: "native" } });
  remember(h);
  h.item(echo("child-answer"), true, "child");
  h.item(echo("root-answer"), true);
  expect(h.state.items["child-answer"]).not.toHaveProperty("origin");
  expect(h.state.items["root-answer"]).toHaveProperty("origin.interactionId", "interaction-1");
});
test("a refused answer never tags a later person's equal message", () => {
  const h = setup();
  remember(h);
  h.feed({
    seq: 100,
    t: 100,
    dir: "note",
    channel: "stdio",
    data: { event: "interaction-answer-failed", threadId: "native", interaction: "async:q" },
  });
  h.item(echo("person"), true);
  expect(h.state.items["person"]).not.toHaveProperty("origin");
});
