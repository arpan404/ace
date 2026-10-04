import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("ace results reach Codex as untrusted additional context without user input", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send([{ type: "text", text: "ace child results" }], "queue", "wake", "ace");
    const request = h.frames.find(
      (frame) => frame.dir === "send" && obj(frame.data).method === "turn/start",
    );
    expect(obj(request?.data).params).toMatchObject({
      input: [],
      turnTrigger: "subagent_result",
      additionalContext: { "ace.delegation": { kind: "untrusted", value: "ace child results" } },
    });
  } finally {
    await h.dispose();
  }
});
