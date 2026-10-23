import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { InputRejected } from "@ace/engine-api";
import { obj } from "./native.ts";

test("a steer rejected because its turn ended delivers the same input in a new turn", async () => {
  const h = await sessionHarness(false, "steer-race");
  try {
    await h.session.send([{ type: "text", text: "steer-race" }], "queue");
    await h.wait((frame) => obj(frame.data)["method"] === "turn/started");
    await h.session.send([{ type: "text", text: "finish" }], "steer", "next-input");
    await h.wait(
      (frame) =>
        Boolean(obj(obj(frame.data)["params"])["turn"]) &&
        obj(frame.data)["method"] === "turn/completed",
    );
    const inputs = h.frames
      .filter((frame) => frame.dir === "send" && obj(frame.data)["method"] === "turn/start")
      .map((frame) => obj(obj(frame.data)["params"])["input"]);
    expect(inputs).toContainEqual([{ type: "text", text: "finish", text_elements: [] }]);
  } finally {
    await h.dispose();
  }
});

test.each(["steer-replaced-turn", "steer-replaced-after-end"])(
  "a steer racing a replacement turn (%s) reaches that turn once",
  async (mode) => {
    const h = await sessionHarness(false, mode);
    try {
      await h.session.send([{ type: "text", text: "running" }], "queue");
      await h.wait((frame) => obj(frame.data)["method"] === "turn/started");
      await h.session.send([{ type: "text", text: "correction" }], "steer", "replacement-input");
      await h.wait(
        (frame) => obj(obj(obj(frame.data)["params"])["item"])["text"] === "steered: correction",
      );
      const starts = h.frames.filter(
        (frame) => frame.dir === "send" && obj(frame.data)["method"] === "turn/start",
      );
      expect(starts).toHaveLength(1);
      const steers = h.frames.filter(
        (frame) => frame.dir === "send" && obj(frame.data)["method"] === "turn/steer",
      );
      expect(steers.map((frame) => obj(obj(frame.data)["params"])["clientUserMessageId"])).toEqual([
        "offline-message",
        "offline-message",
      ]);
      const echoes = h.frames.filter(
        (frame) => obj(obj(obj(frame.data)["params"])["item"])["type"] === "userMessage",
      );
      expect(echoes).toHaveLength(1);
      expect(obj(obj(echoes[0]?.data)["params"])["turnId"]).toBe("replacement");
    } finally {
      await h.dispose();
    }
  },
);

test("an unrelated steer refusal is never retried as a new turn", async () => {
  const h = await sessionHarness(false, "steer-refused");
  try {
    await h.session.send([{ type: "text", text: "running" }], "queue");
    await h.wait((frame) => obj(frame.data)["method"] === "turn/started");
    await expect(h.session.send([{ type: "text", text: "correction" }], "steer")).rejects.toThrow(
      "provider refused input",
    );
    const deliveries = h.frames.filter(
      (frame) =>
        frame.dir === "send" &&
        ["turn/start", "turn/steer"].includes(String(obj(frame.data)["method"])),
    );
    expect(deliveries.map((frame) => obj(frame.data)["method"])).toEqual([
      "turn/start",
      "turn/steer",
    ]);
  } finally {
    await h.dispose();
  }
});

test("a steer Codex refuses for a turn it already left is reported as unread, never started again", async () => {
  const h = await sessionHarness(false, "steer-stale-turn");
  try {
    await h.session.send([{ type: "text", text: "steer-stale-turn" }], "queue");
    await h.wait((frame) => obj(frame.data)["method"] === "turn/started");
    await expect(
      h.session.send([{ type: "text", text: "correction" }], "steer", "stale-input"),
    ).rejects.toBeInstanceOf(InputRejected);
    const starts = h.frames.filter(
      (frame) => frame.dir === "send" && obj(frame.data)["method"] === "turn/start",
    );
    expect(starts).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
