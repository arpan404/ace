import { expect, test } from "vitest";
import { setup, wakes } from "./test-support.ts";
import { createAgentControlPort } from "./tools.ts";

test("asynchronous child results survive native user-role echoes as ace events", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "greeter");
  await h.engine.flush();
  await h.complete(child.childId, "Hello from the child");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.errors).toEqual([]);
  const text = h.inputs.get(parent.threadId)?.at(-1);
  if (!text) throw new Error("Missing parent context");
  const nativeId = h.inputMessages.get(parent.threadId)?.at(-1)?.nativeId;
  if (!nativeId) throw new Error("Missing native message identity");
  expect(text).toContain("[ace-origin:delegation.settled:");
  await h.emit(parent.threadId, {
    type: "item.upsert",
    agent: "root",
    item: "provider-echo",
    draft: {
      type: "message",
      nativeId,
      role: "user",
      parts: [{ type: "text", text }],
      complete: true,
    },
  });
  await h.close();
  const restarted = setup({}, h.dbPath);
  const caller = restarted.caller(parent.threadId);
  restarted.service.message(caller, "resume-after-restart", parent.threadId, "Continue", "queue");
  await restarted.engine.flush();
  await restarted.emit(parent.threadId, {
    type: "item.reconciled",
    agent: "root",
    item: "replayed-echo",
    draft: {
      type: "message",
      nativeId,
      role: "user",
      parts: [{ type: "text", text }],
      complete: true,
    },
  });
  const page = restarted.store.readItemPage(parent.threadId, restarted.store.headSeq() + 1, 50);
  expect(page.items.filter((item) => item.type === "message" && item.role === "user")).toEqual([]);
  const results = page.items.filter((item) => item.type === "delegation.settled");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    origin: "ace",
    delivery: "ace-input",
    results: [{ threadId: child.childId, outcome: "completed", result: "Hello from the child" }],
  });
  expect(
    Object.values(restarted.store.snapshotThread(parent.threadId).items).filter(
      (item) => item.type === "delegation.settled",
    ),
  ).toHaveLength(1);
});

test("copying ace wake text through a user command remains user input across replay", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "copied-wake");
  await h.engine.flush();
  await h.complete(child.childId, "Original result");
  h.clock.advance(1050);
  await h.engine.flush();
  const text = h.inputs.get(parent.threadId)?.at(-1);
  if (!text) throw new Error("Missing wake");
  const before = h.store
    .readItemPage(parent.threadId, h.store.headSeq() + 1, 50)
    .items.filter((item) => item.type === "delegation.settled");
  expect(
    h.service.command("copied-by-user", {
      type: "thread.send",
      threadId: parent.threadId,
      delivery: "queue",
      input: [{ type: "text", text }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const nativeId = h.inputMessages.get(parent.threadId)?.at(-1)?.nativeId;
  if (!nativeId) throw new Error("Missing user identity");
  await h.emit(parent.threadId, {
    type: "item.upsert",
    agent: "root",
    item: "copied-user-input",
    draft: {
      type: "message",
      role: "user",
      nativeId,
      parts: [{ type: "text", text }],
      complete: true,
    },
  });
  await h.close();
  const restarted = setup({}, h.dbPath);
  restarted.service.message(
    restarted.caller(parent.threadId),
    "resume-copy",
    parent.threadId,
    "Continue",
    "queue",
  );
  await restarted.engine.flush();
  await restarted.emit(parent.threadId, {
    type: "item.reconciled",
    agent: "root",
    item: "copied-user-input",
    draft: {
      type: "message",
      role: "user",
      nativeId,
      parts: [{ type: "text", text }],
      complete: true,
    },
  });
  const page = restarted.store.readItemPage(parent.threadId, restarted.store.headSeq() + 1, 50);
  expect(
    page.items.filter((item) => item.type === "message" && item.role === "user"),
  ).toContainEqual(expect.objectContaining({ parts: [{ type: "text", text }] }));
  expect(page.items.filter((item) => item.type === "delegation.settled")).toEqual(before);
  expect(restarted.errors).toEqual([]);
});

test("waiting delegate returns results through its MCP tool without a duplicate parent wake", async () => {
  const h = setup();
  const parent = await h.parent();
  const port = createAgentControlPort(h.store, h.service);
  const result = port.execute(
    parent,
    {
      op: "delegate_task",
      requestId: "wait-greeter",
      provider: "claude",
      role: "greeter",
      task: "Say hello",
      wait: true,
      estimatedLoad: 0,
    },
    new AbortController().signal,
  );
  await h.engine.flush();
  const child = h.service.journal.receipt(parent.threadId, "wait-greeter");
  if (!child) throw new Error("Missing child");
  await h.complete(child.childId, "Hello");
  expect(await result).toMatchObject({
    ok: true,
    data: { threadId: child.childId, outcome: { outcome: "completed", result: "Hello" } },
  });
  h.clock.advance(1050);
  await h.engine.flush();
  expect(wakes(h.events, parent.threadId)).toHaveLength(0);
  expect(h.store.readItemPage(parent.threadId, h.store.headSeq() + 1, 50).items).toContainEqual(
    expect.objectContaining({
      type: "delegation.settled",
      delivery: "tool",
      results: [expect.objectContaining({ threadId: child.childId, result: "Hello" })],
    }),
  );
});

test("cancelling a waiting call leaves child work running and delivers its eventual result", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "cancelled-wait", true);
  await h.engine.flush();
  const signal = new AbortController();
  const wait = h.service.wait(parent, child.childId, signal.signal);
  signal.abort();
  await expect(wait).rejects.toThrow("Wait cancelled");
  expect(h.store.getThread(child.childId)?.status.state).toBe("working");
  await h.complete(child.childId, "Still delivered");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.errors).toEqual([]);
  expect(wakes(h.events, parent.threadId)).toHaveLength(1);
});
