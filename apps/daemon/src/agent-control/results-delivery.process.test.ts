import { DatabaseSync } from "node:sqlite";
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
  expect(
    page.items.filter(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        item.parts.some((part) => part.type === "text" && part.text === text),
    ),
  ).toEqual([]);
  expect(page.items).toContainEqual(
    expect.objectContaining({
      type: "message",
      origin: expect.objectContaining({ kind: "person" }),
      parts: [expect.objectContaining({ type: "text", text: "plan" })],
    }),
  );
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
  const sentId = h.inputMessages.get(parent.threadId)?.at(-1)?.nativeId;
  if (!sentId) throw new Error("Missing user identity");
  const nativeId = `echo:${sentId}`;
  // Provider metadata cannot override the durable host command's attribution.
  const claimedOrigin = { commandId: "copied-by-user", nativeId, origin: "ace" };
  const context = h.contexts.get(parent.threadId);
  if (!context?.onInputMessage) throw new Error("Missing input correlation boundary");
  context.onInputMessage(claimedOrigin);
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
  ).toContainEqual(
    expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text })] }),
  );
  const copies = page.items.filter(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      item.parts.some((part) => part.type === "text" && part.text === text),
  );
  expect(copies).toHaveLength(1);
  expect(copies[0]).toMatchObject({
    id: "input:copied-by-user",
    origin: { kind: "person", commandId: "copied-by-user" },
    nativeId,
  });
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

// Recreate the persisted #116 identity fixture, then exercise native replay through the engine.
test("delegation wakes from the previous identity journal remain ace events after upgrade", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "legacy-wake");
  await h.engine.flush();
  await h.complete(child.childId, "Legacy result");
  h.clock.advance(1050);
  await h.engine.flush();
  const identity = h.inputMessages.get(parent.threadId)?.at(-1);
  const text = h.inputs.get(parent.threadId)?.at(-1);
  if (!identity || !text) throw new Error("Missing wake input");
  await h.close();
  const legacy = new DatabaseSync(h.dbPath);
  try {
    legacy.exec(`CREATE TABLE engine_input_messages (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      native_id TEXT NOT NULL, command_id TEXT NOT NULL, origin TEXT NOT NULL,
      PRIMARY KEY(thread_id,native_id));
      DROP TABLE engine_input_identities;
      DELETE FROM engine_inputs WHERE json_extract(origin,'$.kind')='subagent_result';`);
    legacy
      .prepare("INSERT INTO engine_input_messages VALUES (?,?,?,?)")
      .run(parent.threadId, identity.nativeId, identity.commandId, "ace");
  } finally {
    legacy.close();
  }
  const restarted = setup({}, h.dbPath);
  await restarted.engine.ready();
  restarted.service.message(
    restarted.caller(parent.threadId),
    "upgrade-resume",
    parent.threadId,
    "Continue",
    "queue",
  );
  await restarted.engine.flush();
  await restarted.emit(parent.threadId, {
    type: "item.reconciled",
    agent: "root",
    item: "legacy-native-echo",
    draft: {
      type: "message",
      role: "user",
      nativeId: identity.nativeId,
      parts: [{ type: "text", text }],
      complete: true,
    },
  });
  const items = restarted.store.readItemPage(
    parent.threadId,
    restarted.store.headSeq() + 1,
    50,
  ).items;
  expect(items.filter((item) => item.type === "delegation.settled")).toEqual([
    expect.objectContaining({
      results: [expect.objectContaining({ threadId: child.childId, result: "Legacy result" })],
    }),
  ]);
  expect(
    items.some(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        item.parts.some((part) => part.type === "text" && part.text === text),
    ),
  ).toBe(false);
  expect(restarted.errors).toEqual([]);
});

test("delegation outcomes preserve answers larger than one kilobyte and mark bounded truncation", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "long-answer");
  await h.engine.flush();
  await h.complete(child.childId, "A".repeat(5000));
  h.clock.advance(1050);
  await h.engine.flush();
  expect(await h.service.wait(parent, child.childId, new AbortController().signal)).toMatchObject({
    result: "A".repeat(4096),
    truncated: true,
  });
});
