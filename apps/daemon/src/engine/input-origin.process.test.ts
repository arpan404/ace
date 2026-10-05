import type { Fact } from "@ace/core";
import { afterEach, expect, test } from "vitest";
import { applyEvent, createThreadView } from "@ace/projection";
import { harness, scriptFrames, start, end } from "./test-support.ts";
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
});

test("a sent message appears once before provider startup and keeps its id when echoed", async () => {
  const frames = scriptFrames();
  const echo = {
    type: "item.upsert",
    agent: "root",
    item: "native-person",
    draft: {
      type: "message",
      role: "user",
      parts: [{ type: "text", text: "first" }],
      complete: true,
      synthetic: false,
      nativeId: "native-first",
    },
  } satisfies Fact;
  const h = await harness([{ on: "send", frames: [frames.frame(start, echo, end)] }], frames);
  close.push(h.close);
  const receipt = h.command(
    {
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: [{ type: "text", text: "first" }],
    },
    "device",
    "create-person",
  );
  if (!receipt.threadId) throw new Error("Missing thread");
  const before = h.store.snapshotThread(receipt.threadId);
  expect(h.contexts).toHaveLength(0);
  expect(before.items["input:create-person"]).toMatchObject({
    type: "message",
    parts: [{ type: "text", text: "first" }],
    origin: { kind: "person", commandId: "create-person" },
  });
  await h.engine.flush();
  const after = h.store.snapshotThread(receipt.threadId);
  expect(
    Object.values(after.items).filter((item) => item.type === "message" && item.role === "user"),
  ).toHaveLength(1);
  expect(after.items["input:create-person"]).toMatchObject({ nativeId: "native-first" });
  const view = createThreadView(before.thread);
  for (const event of h.store.readEvents({
    afterSeq: 0,
    threadId: receipt.threadId,
    limit: 1000,
  })) {
    view.seq = event.seq - 1;
    applyEvent(view, event);
  }
  expect(view.itemOrder).toEqual(after.itemOrder);
});

test("delegation results retain their origin when a provider echoes them as user text", async () => {
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
              item: "child-echo",
              draft: {
                type: "message",
                role: "user",
                parts: [{ type: "text", text: "child result" }],
                complete: true,
                synthetic: false,
              },
            },
            end,
          ),
        ],
      },
    ],
    frames,
  );
  close.push(h.close);
  const id = await h.create();
  h.command(
    {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "child result" }],
      trigger: "subagent_result",
      origin: { kind: "subagent_result", threadIds: [id] },
    },
    "device",
    "result",
  );
  await h.engine.flush();
  const item = h.store.snapshotThread(id).items["input:result"];
  expect(item).toMatchObject({
    synthetic: true,
    origin: { kind: "subagent_result", commandId: "result", threadIds: [id] },
  });
  expect(
    Object.values(h.store.snapshotThread(id).items).filter((message) => message.type === "message"),
  ).toHaveLength(2);
});
