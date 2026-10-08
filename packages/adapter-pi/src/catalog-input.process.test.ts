import { expect, test } from "vitest";
import { sessionHarness } from "./testing/harness.ts";
import { obj } from "./native.ts";
test("multiple Pi command selections in prose become separate native prefix admissions", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(
      [
        { type: "text", text: "Use " },
        {
          type: "mention",
          entryId: "one",
          kind: "command",
          name: "First",
          arguments: "input",
          invocation: { type: "slash", name: "first" },
        },
        { type: "text", text: " then " },
        {
          type: "mention",
          entryId: "two",
          kind: "command",
          name: "Second",
          arguments: "",
          invocation: { type: "slash", name: "second" },
        },
      ],
      "queue",
    );
    const inputs = h.frames
      .filter((f) => f.dir === "send" && obj(f.data).type === "prompt")
      .map((f) => obj(f.data));
    expect(inputs).toMatchObject([
      {
        message: "/first input\n\nMessage context:\n\nUse [First]\n then [Second]",
        streamingBehavior: "followUp",
      },
      {
        message: "/second\n\nMessage context:\n\nUse [First]\n then [Second]",
        streamingBehavior: "followUp",
      },
    ]);
  } finally {
    await h.dispose();
  }
});
