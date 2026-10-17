import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const reply = (item: string, text: string): Fact => ({
  type: "item.upsert",
  agent: "root",
  item,
  draft: { type: "message", role: "assistant", parts: [{ type: "text", text }], complete: true },
});

type Harness = Awaited<ReturnType<typeof harness>>;

/** Message texts in the order the daemon first created them: the transcript's order. */
function creationOrder(h: Harness, id: ThreadId): string[] {
  const texts: string[] = [];
  for (const event of h.store.readEvents({ afterSeq: 0, threadId: id, limit: 1000 }))
    if (event.payload.type === "item.created" && event.payload.item.type === "message")
      for (const part of event.payload.item.parts) if (part.type === "text") texts.push(part.text);
  return texts;
}

/** The run of the message whose text is `text`, as stored. */
function runOf(h: Harness, id: ThreadId, text: string): string | undefined {
  const item = Object.values(h.store.snapshotThread(id).items).find(
    (entry) =>
      entry.type === "message" &&
      entry.parts.some((part) => part.type === "text" && part.text === text),
  );
  if (!item) throw new Error(`Missing message ${text}`);
  return item.runId;
}

function session(h: Harness) {
  const context = h.contexts.at(-1);
  if (!context) throw new Error("Missing session");
  return context;
}

function send(h: Harness, id: ThreadId, text: string, delivery: "queue" | "steer") {
  const result = h.command({
    type: "thread.send",
    threadId: id,
    delivery,
    input: [{ type: "text", text }],
  });
  expect(result.ok).toBe(true);
}

test("messages queued behind a run join the transcript after it, each before its own answer", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, reply("r1-a", "working on first"))] },
      { on: "send", frames: [frames.frame(start, reply("a1", "answer one"), end)] },
      { on: "send", frames: [frames.frame(start, reply("a2", "answer two"), end)] },
      { on: "send", frames: [frames.frame(start, reply("a3", "answer three"), end)] },
    ],
    frames,
  );
  try {
    const id = await h.create();
    for (const text of ["q1", "q2", "q3"]) send(h, id, text, "queue");
    await h.engine.flush();
    await session(h).onFrame(frames.frame(reply("r1-b", "first is done"), end));
    await h.engine.flush();

    expect(creationOrder(h, id)).toEqual([
      "first",
      "working on first",
      "first is done",
      "q1",
      "answer one",
      "q2",
      "answer two",
      "q3",
      "answer three",
    ]);
    const first = runOf(h, id, "first");
    expect(runOf(h, id, "first is done")).toBe(first);
    for (const [ask, answer] of [
      ["q1", "answer one"],
      ["q2", "answer two"],
      ["q3", "answer three"],
    ] as const) {
      expect(runOf(h, id, ask)).toBe(runOf(h, id, answer));
      expect(runOf(h, id, ask)).not.toBe(first);
    }
  } finally {
    await h.close();
  }
});

test("messages the provider takes into one turn all belong to that turn", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, reply("r1-a", "working on first"))] },
      // The provider holds the queued message and the steers that follow it for one turn.
      { on: "send" },
      { on: "send" },
      { on: "send" },
    ],
    frames,
    { steer: true },
  );
  try {
    const id = await h.create();
    send(h, id, "q1", "queue");
    await h.engine.flush();
    await session(h).onFrame(frames.frame(reply("r1-b", "first is done"), end));
    await h.engine.flush();
    send(h, id, "q2", "steer");
    send(h, id, "q3", "steer");
    await h.engine.flush();
    expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(4);
    await session(h).onFrame(frames.frame(start, reply("a", "answer to all three"), end));
    await h.engine.flush();

    expect(creationOrder(h, id)).toEqual([
      "first",
      "working on first",
      "first is done",
      "q1",
      "q2",
      "q3",
      "answer to all three",
    ]);
    const answered = runOf(h, id, "answer to all three");
    for (const ask of ["q1", "q2", "q3"]) expect(runOf(h, id, ask)).toBe(answered);
    expect(answered).not.toBe(runOf(h, id, "first"));
  } finally {
    await h.close();
  }
});

test("messages steered into a working run belong to it, where they were sent", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, reply("r1-a", "working on first"))] },
      { on: "send" },
      { on: "send" },
      { on: "send" },
    ],
    frames,
    { steer: true },
  );
  try {
    const id = await h.create();
    for (const text of ["q1", "q2", "q3"]) send(h, id, text, "steer");
    await h.engine.flush();
    await session(h).onFrame(frames.frame(reply("r1-b", "took all three in"), end));
    await h.engine.flush();

    expect(creationOrder(h, id)).toEqual([
      "first",
      "working on first",
      "q1",
      "q2",
      "q3",
      "took all three in",
    ]);
    const first = runOf(h, id, "first");
    for (const ask of ["q1", "q2", "q3", "took all three in"])
      expect(runOf(h, id, ask)).toBe(first);
  } finally {
    await h.close();
  }
});
