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

/** Message texts in the order of their daemon creation sequence: the transcript's order. */
function creationOrder(h: Harness, id: ThreadId): string[] {
  const shown = new Map<string, string[]>();
  for (const { payload } of h.store.readEvents({ afterSeq: 0, threadId: id, limit: 1000 }))
    if (payload.type === "item.deleted") shown.delete(payload.itemId);
    else if (payload.type === "item.created" && payload.item.type === "message") {
      shown.delete(payload.item.id);
      shown.set(
        payload.item.id,
        payload.item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      );
    }
  return [...shown.values()].flat();
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

/** Sends carry a native id the provider reports back, as Claude, Codex and Cursor sends do. */
function identifyingSends(h: Harness): void {
  const original = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(ctx) {
        const opened = await original.openSession(ctx);
        return {
          ...opened,
          async send(input, delivery, commandId, origin) {
            if (commandId) ctx.onInputMessage?.({ commandId, nativeId: `native:${commandId}` });
            await opened.send(input, delivery, commandId, origin);
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
}

async function steeringHarness() {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, reply("r1-a", "working on first"))] },
      { on: "send" },
    ],
    frames,
    { steer: true },
  );
  identifyingSends(h);
  const id = await h.create();
  const steer = h.command(
    { type: "thread.send", threadId: id, delivery: "steer", input: [{ type: "text", text: "q1" }] },
    "device",
    "steer-q1",
  );
  expect(steer.ok).toBe(true);
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toMatchObject({ type: "send", delivery: "steer" });
  return { frames, h, id };
}

/** The provider finished the running turn without the steer. */
async function turnEndsFirst(h: Harness, frames: ReturnType<typeof scriptFrames>) {
  await session(h).onFrame(frames.frame(reply("r1-b", "first is done"), end));
  await h.engine.flush();
}

function expectAnsweredByNextRun(h: Harness, id: ThreadId): void {
  expect(creationOrder(h, id)).toEqual([
    "first",
    "working on first",
    "first is done",
    "q1",
    "answer to q1",
  ]);
  const first = runOf(h, id, "first");
  expect(runOf(h, id, "first is done")).toBe(first);
  expect(runOf(h, id, "q1")).toBe(runOf(h, id, "answer to q1"));
  expect(runOf(h, id, "q1")).not.toBe(first);
  expect(
    Object.values(h.store.snapshotThread(id).items).filter(
      (item) => item.type === "message" && item.role === "user",
    ),
  ).toHaveLength(2);
}

const consumed: Fact = {
  type: "input.consumed",
  agent: "root",
  nativeInputIds: ["native:steer-q1"],
};

test("a steer the provider reports consumed by the next turn moves to that turn", async () => {
  const { frames, h, id } = await steeringHarness();
  try {
    await turnEndsFirst(h, frames);
    await session(h).onFrame(frames.frame(start, consumed, reply("a1", "answer to q1"), end));
    await h.engine.flush();
    expectAnsweredByNextRun(h, id);
  } finally {
    await h.close();
  }
});

test("a steer the provider delivers between turns joins the turn that starts after it", async () => {
  const { frames, h, id } = await steeringHarness();
  try {
    await turnEndsFirst(h, frames);
    await session(h).onFrame(frames.frame(consumed));
    await session(h).onFrame(frames.frame(start, reply("a1", "answer to q1"), end));
    await h.engine.flush();
    expectAnsweredByNextRun(h, id);
  } finally {
    await h.close();
  }
});

test.each([
  ["its native id", { nativeId: "native:steer-q1" }],
  ["its text alone", {}],
])("a steer the provider echoes by %s in the next turn moves to that turn", async (_, echo) => {
  const { frames, h, id } = await steeringHarness();
  try {
    await turnEndsFirst(h, frames);
    await session(h).onFrame(
      frames.frame(
        start,
        {
          type: "item.upsert",
          agent: "root",
          item: "native-user-echo",
          draft: {
            type: "message",
            role: "user",
            parts: [{ type: "text", text: "q1" }],
            complete: true,
            ...echo,
          },
        },
        reply("a1", "answer to q1"),
        end,
      ),
    );
    await h.engine.flush();
    expectAnsweredByNextRun(h, id);
  } finally {
    await h.close();
  }
});

test("a steer the running turn reports consuming stays where it was sent", async () => {
  const { frames, h, id } = await steeringHarness();
  try {
    await session(h).onFrame(frames.frame(consumed, reply("r1-b", "took q1 in"), end));
    await h.engine.flush();
    expect(creationOrder(h, id)).toEqual(["first", "working on first", "q1", "took q1 in"]);
    expect(runOf(h, id, "q1")).toBe(runOf(h, id, "first"));
  } finally {
    await h.close();
  }
});
