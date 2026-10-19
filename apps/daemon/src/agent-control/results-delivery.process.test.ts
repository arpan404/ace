import { expect, test } from "vitest";
import { setup, wakes } from "./test-support.ts";
import { createAgentControlPort } from "./tools.ts";
import { start, end } from "../engine/test-support.ts";

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
      role: "wait-greeter-task",
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

test("a finished child's result is steered into a busy parent that supports steering", async () => {
  const h = setup(
    {},
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  const parent = await h.parent();
  // Parent starts its own turn and stays in it while the child finishes.
  await h.emit(parent.threadId, start);
  const child = h.delegate(parent, "steered-result");
  await h.engine.flush();
  await h.complete(child.childId, "steered hello");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.errors).toEqual([]);
  // Never a user-visible queue entry, even briefly: the Queued strip stays empty.
  expect(h.engine.queue(parent.threadId).messages).toEqual([]);
  // Injected now, while the parent is still busy, via steer delivery.
  const delivered = h.inputMessages.get(parent.threadId)?.at(-1);
  expect(delivered?.delivery).toBe("steer");
  expect(h.inputs.get(parent.threadId)?.join("\n")).toContain("steered hello");
  const settled = h.store
    .readItemPage(parent.threadId, h.store.headSeq() + 1, 50)
    .items.filter((item) => item.type === "delegation.settled");
  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({
    origin: "ace",
    results: [expect.objectContaining({ threadId: child.childId, result: "steered hello" })],
  });
});

test("with no steering, the result waits out of the person's queue and is delivered when the turn ends", async () => {
  const h = setup();
  const parent = await h.parent();
  await h.emit(parent.threadId, start);
  // The person's own follow-up queues while the parent is busy.
  expect(
    h.service.command("person-followup", {
      type: "thread.send",
      threadId: parent.threadId,
      delivery: "queue",
      input: [{ type: "text", text: "person follow-up" }],
    }).ok,
  ).toBe(true);
  const child = h.delegate(parent, "queued-result");
  await h.engine.flush();
  await h.complete(child.childId, "queued hello");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.errors).toEqual([]);
  // Daemon-owned pending ace input: the person's queue shows only their message.
  const waiting = h.engine.queue(parent.threadId);
  expect(waiting.messages).toHaveLength(1);
  expect(waiting.messages[0]?.input).toEqual([{ type: "text", text: "person follow-up" }]);
  expect(h.inputs.get(parent.threadId)?.join("\n") ?? "").not.toContain("queued hello");
  // The transcript already records the ace result while delivery waits.
  expect(
    h.store
      .readItemPage(parent.threadId, h.store.headSeq() + 1, 50)
      .items.filter((item) => item.type === "delegation.settled"),
  ).toHaveLength(1);
  // The turn ends: the agent result runs before the person's queued message.
  await h.emit(parent.threadId, end);
  await h.engine.flush();
  expect(h.errors).toEqual([]);
  const sent = h.inputs.get(parent.threadId)?.join("\n") ?? "";
  expect(sent).toContain("queued hello");
  expect(sent).toContain("person follow-up");
  expect(sent.indexOf("queued hello")).toBeLessThan(sent.indexOf("person follow-up"));
  expect(h.engine.queue(parent.threadId).messages).toEqual([]);
});

test("a pending result is delivered once after a daemon restart", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "restarted-result");
  await h.engine.flush();
  await h.complete(child.childId, "restarted hello");
  // Wake not yet due: the result is pending in the journal, no send yet.
  await h.close();
  const restarted = setup({}, h.dbPath);
  restarted.clock.advance(1050);
  await restarted.engine.flush();
  expect(restarted.errors).toEqual([]);
  expect(restarted.inputs.get(parent.threadId)?.join("\n") ?? "").toContain("restarted hello");
  const occurrences = (restarted.inputs.get(parent.threadId) ?? []).filter((text) =>
    text.includes("restarted hello"),
  );
  expect(occurrences).toHaveLength(1);
  expect(
    restarted.store
      .readItemPage(parent.threadId, restarted.store.headSeq() + 1, 50)
      .items.filter((item) => item.type === "delegation.settled"),
  ).toHaveLength(1);
});
