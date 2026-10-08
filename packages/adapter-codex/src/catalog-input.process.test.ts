import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

test("the app-server receives native skill and app references between the surrounding text parts", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(
      [
        { type: "text", text: "attachment-proof" },
        {
          type: "mention",
          entryId: "selected-skill",
          name: "Review",
          kind: "skill",
          arguments: "",
          invocation: {
            type: "skill",
            name: "review",
            path: `${h.cwd}/.agents/skills/review/SKILL.md`,
          },
        },
        { type: "text", text: " with " },
        {
          type: "mention",
          entryId: "selected-app",
          name: "Drive",
          kind: "plugin",
          arguments: "",
          invocation: { type: "mention", name: "Drive", path: "app://scratch-drive" },
        },
        { type: "text", text: " for the current project." },
      ],
      "queue",
    );
    const proof = await h.wait(
      (f) => f.dir === "recv" && obj(f.data).method === "test/attachments",
    );
    expect(obj(obj(proof.data).params).input).toEqual([
      { type: "text", text: "attachment-proof", text_elements: [] },
      { type: "skill", name: "review", path: `${h.cwd}/.agents/skills/review/SKILL.md` },
      { type: "text", text: " with ", text_elements: [] },
      { type: "mention", name: "Drive", path: "app://scratch-drive" },
      { type: "text", text: " for the current project.", text_elements: [] },
    ]);
  } finally {
    await h.dispose();
  }
});
