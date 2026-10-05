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
  const echo: Fact = {
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
  };
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
  h.internalCommand(
    {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "child result" }],
      trigger: "subagent_result",
      origin: { kind: "subagent_result", threadIds: [id] },
    },
    "result",
  );
  await h.engine.flush();
  const item = h.store.snapshotThread(id).items["input:result"];
  expect(item).toMatchObject({
    synthetic: true,
    origin: { kind: "subagent_result", commandId: "result", threadIds: [id] },
  });
  expect(
    Object.values(h.store.snapshotThread(id).items).filter(
      (candidate) => candidate.type === "message",
    ),
  ).toHaveLength(2);
});

test("provider-expanded context echoes preserve the person's original message parts", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            {
              type: "item.upsert",
              agent: "root",
              item: "expanded-echo",
              draft: {
                type: "message",
                role: "user",
                parts: [{ type: "text", text: "Attached context\nOriginal question" }],
                complete: true,
              },
            },
            end,
          ),
        ],
      },
    ],
    frames,
    {
      prepareInput: async () => ({
        input: [{ type: "text", text: "Attached context\nOriginal question" }],
        release() {},
      }),
    },
  );
  close.push(h.close);
  const receipt = h.command(
    {
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      context: { mentions: [{ path: "notes.md" }], attachments: [] },
      input: [{ type: "text", text: "Original question" }],
    },
    "device",
    "expanded",
  );
  if (!receipt.threadId) throw new Error("Missing thread");
  await h.engine.flush();
  const items = Object.values(h.store.snapshotThread(receipt.threadId).items).filter(
    (item) => item.type === "message",
  );
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    id: "input:expanded",
    parts: [{ type: "text", text: "Original question" }],
    nativeId: "expanded-echo",
  });
});

test("external sends cannot forge ace provenance or trusted run triggers", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  close.push(h.close);
  const result = h.command(
    {
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: [{ type: "text", text: "person text" }],
      trigger: "subagent_result",
      origin: { kind: "handoff" },
    },
    "ace-agent",
    "forged",
  );
  if (!result.threadId) throw new Error("Missing thread");
  expect(h.store.snapshotThread(result.threadId).items["input:forged"]).toMatchObject({
    synthetic: false,
    origin: { kind: "person", commandId: "forged" },
  });
  await h.engine.flush();
  expect(Object.values(h.store.snapshotThread(result.threadId).runs)[0]?.trigger).toBe("user");
});
