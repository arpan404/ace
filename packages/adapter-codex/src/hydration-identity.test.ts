import { expect, test } from "vitest";
import { createCodexTranslator } from "./index.ts";
import { ThreadId } from "@ace/protocol";
import { setup } from "./translator.test-helper.ts";

test("a replacement translator preserves both terminal question identities and their answers", () => {
  const h = setup();
  const questions = ["answered-a", "answered-b"].map((id) => ({
    type: "agentMessage",
    id,
    delivery: "async",
    text: "Previously answered",
    questions: [{ title: "Continue?", options: ["yes", "no"] }],
  }));
  h.start();
  for (const item of questions) {
    h.item(item, true);
    h.feedFact(
      {
        type: "interaction.closed",
        interaction: `async:${item.id}`,
        state: "resolved",
        resolution: { kind: "question", answers: { q0: ["yes"] } },
      },
      20,
    );
  }
  h.end();
  const identities = Object.values(h.state.interactions).map((i) => i.id);
  const translator = createCodexTranslator({
    threadId: ThreadId.parse("fixture"),
    rootKey: "root",
  });
  translator.translate(
    {
      seq: 0,
      t: 30,
      dir: "send",
      channel: "stdio",
      data: { id: 1, method: "thread/resume", params: { threadId: "native" } },
    },
    30,
  );
  const facts = translator.translate(
    {
      seq: 1,
      t: 31,
      dir: "recv",
      channel: "stdio",
      data: {
        id: 1,
        result: {
          thread: {
            id: "native",
            status: { type: "idle" },
            turns: [{ id: "turn", status: "completed", items: questions }],
          },
        },
      },
    },
    31,
  );
  for (const fact of facts) h.feedFact(fact, 31);
  expect(Object.values(h.state.interactions).map((i) => i.id)).toEqual(identities);
  expect(
    Object.values(h.state.interactions).map((i) => ({ state: i.state, resolution: i.resolution })),
  ).toEqual([
    { state: "resolved", resolution: { kind: "question", answers: { q0: ["yes"] } } },
    { state: "resolved", resolution: { kind: "question", answers: { q0: ["yes"] } } },
  ]);
});
