import { expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";

test.each(["spawn", "parent_agent", "subagent_result", "schedule"] as const)(
  "%s input releases engine queue ownership when a provider starts its run",
  async (trigger) => {
    const frames = scriptFrames();
    const h = await harness(
      [
        { on: "send", frames: [frames.frame(start, end)] },
        {
          on: "send",
          frames: [
            frames.frame(
              start,
              {
                type: "item.upsert",
                agent: "root",
                item: "next-output",
                draft: {
                  type: "message",
                  role: "assistant",
                  parts: [{ type: "text", text: "next delivered" }],
                  complete: true,
                },
              },
              end,
            ),
          ],
        },
      ],
      frames,
    );
    try {
      const created = h.command({
        type: "thread.create",
        workspaceId: h.workspace,
        provider: "codex",
        trigger,
        input: [{ type: "text", text: "autonomous" }],
      });
      if (!created.threadId) throw new Error("Missing thread");
      await h.engine.flush();
      expect(
        h.command({
          type: "thread.send",
          threadId: created.threadId,
          delivery: "queue",
          input: [{ type: "text", text: "next" }],
        }).ok,
      ).toBe(true);
      await h.engine.flush();
      const page = h.store.readItemPage(created.threadId, h.store.headSeq() + 1, 20);
      expect(
        page.items.some(
          (item) =>
            item.type === "message" &&
            item.role === "assistant" &&
            item.parts.some((part) => part.type === "text" && part.text === "next delivered"),
        ),
      ).toBe(true);
      expect(h.store.getThread(created.threadId)?.status.state).toBe("done");
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  },
);
