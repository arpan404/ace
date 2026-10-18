import { expect, test } from "vitest";
import { capabilities } from "@ace/adapter-claude";
import { harness, scriptFrames, start } from "./test-support.ts";

test.each(["2.1.286", "2.1.301"])(
  "the steer preference delivers Claude %s follow-ups while its turn is working",
  async (version) => {
    const frames = scriptFrames();
    const h = await harness(
      [{ on: "send", frames: [frames.frame(start)] }, { on: "send" }],
      frames,
      {
        provider: "claude",
        capabilities: capabilities({ installed: true, auth: "logged_in", loginHint: "", version }),
        preferences: { followUpBehavior: "steer" },
      },
    );
    try {
      const id = await h.create();
      expect(h.store.getThread(id)?.status.state).toBe("working");
      const input = [{ type: "text" as const, text: "change direction" }];
      expect(h.command({ type: "thread.send", threadId: id, input }).ok).toBe(true);
      await h.engine.flush();
      expect(h.adapter.commands.at(-1)).toEqual({ type: "send", input, delivery: "steer" });
      expect(h.engine.queue(id).messages).toEqual([]);
      expect(h.store.getThread(id)?.status.state).toBe("working");

      const queued = [{ type: "text" as const, text: "after this turn" }];
      expect(
        h.command({ type: "thread.send", threadId: id, input: queued, delivery: "queue" }).ok,
      ).toBe(true);
      await h.engine.flush();
      expect(h.engine.queue(id).messages[0]?.input).toEqual(queued);
      expect(h.adapter.commands.at(-1)).toEqual({ type: "send", input, delivery: "steer" });
    } finally {
      await h.close();
    }
  },
);

test("a message delivered into the working turn is stamped as a steer; one sent at rest is not", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }, { on: "send" }], frames, {
    provider: "claude",
    capabilities: capabilities({
      installed: true,
      auth: "logged_in",
      loginHint: "",
      version: "2.1.301",
    }),
    preferences: { followUpBehavior: "steer" },
  });
  try {
    const id = await h.create();
    const input = [{ type: "text" as const, text: "change direction" }];
    expect(h.command({ type: "thread.send", threadId: id, input }, "device", "steer-1").ok).toBe(
      true,
    );
    await h.engine.flush();
    const items = h.store.snapshotThread(id).items;
    expect(items["input:steer-1"]).toMatchObject({
      type: "message",
      role: "user",
      synthetic: false,
      origin: { kind: "steer", commandId: "steer-1" },
    });
    const first = Object.entries(items).find(
      ([key, item]) => key !== "input:steer-1" && item.type === "message" && item.role === "user",
    );
    expect(first?.[1]).toMatchObject({ origin: { kind: "person" } });
  } finally {
    await h.close();
  }
});
