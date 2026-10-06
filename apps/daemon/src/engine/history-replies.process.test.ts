import { expect, test } from "vitest";
import { OpenCodeTranslator } from "@ace/adapter-opencode";
import { historyReplyFrames } from "@ace/adapter-opencode/testing";
import { harness, scriptFrames } from "./test-support.ts";

test("a new prompt and replay retain one persisted assistant reply in its original run", async () => {
  const frames = historyReplyFrames();
  const h = await harness(
    [
      { on: "send", frames: frames.initial },
      { on: "send", frames: frames.next },
    ],
    scriptFrames(),
    {
      provider: "opencode",
      createTranslator: (init) => new OpenCodeTranslator(init),
    },
  );
  try {
    const id = await h.create();
    const answers = () =>
      Object.values(h.store.snapshotThread(id).items).filter(
        (item) => item.type === "message" && item.role === "assistant",
      );
    const before = answers();
    expect(before).toHaveLength(1);
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "List downloads" }],
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    const after = answers();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before[0]?.id,
      runId: before[0]?.runId,
      parts: [{ type: "text", text: "Offshift summary" }],
    });
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
});
