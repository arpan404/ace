import { afterEach, expect, test } from "vitest";
import { AgentId, ClientMessage, DeviceId, ItemId, RunId, type EventPayload } from "@ace/protocol";
import { setup, ready, agentId, when } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

// Mutation cases: mixing a jumped page into the live store; dropping a forward cursor;
// returning another thread's correlated reply. Not executed (tests run at merge).
test("jumping to older items leaves the subscribed tail live and closes the gap by bounded windows", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const events = h.daemon.store.appendEvents(
    h.thread.id,
    Array.from({ length: 30 }, (_, index): EventPayload => ({
      type: "item.created",
      item: {
        type: "message",
        id: ItemId.parse(`history-${index}`),
        agentId,
        role: "assistant",
        createdAt: index + 1,
        complete: true,
        synthetic: false,
        raw: [],
        parts: [{ type: "text", text: `Message ${index}` }],
      },
    })),
  );
  const target = events.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === "history-2",
  );
  if (!target) throw new Error("Missing target");
  const { client } = h.make({ limits: { items: 5 } });
  await ready(client);
  const lease = client.thread(h.thread.id);
  await when(
    lease.store.select(["order"], (reader) => reader.order.length),
    (length) => length === 5,
  );
  const tail = [...lease.store.order];
  let window = await client.itemsWindow({
    threadId: h.thread.id,
    aroundSeq: target.seq,
    before: 1,
    after: 2,
  });
  expect(window.items.map((item) => item.id)).toEqual([
    "history-1",
    "history-2",
    "history-3",
    "history-4",
  ]);
  expect(lease.store.order).toEqual(tail);
  expect(window.itemsBefore).toBeGreaterThan(0);
  let advances = 0;
  while (!window.items.some((item) => tail.includes(item.id))) {
    if (window.itemsAfter === null || advances++ > 10)
      throw new Error("Gap cursor did not reach tail");
    window = await client.itemsWindow({
      threadId: h.thread.id,
      aroundSeq: window.itemsAfter + 1,
      before: 0,
      after: 4,
    });
    expect(window.items.length).toBeLessThanOrEqual(5);
  }
  expect(window.items.some((item) => tail.includes(item.id))).toBe(true);
  expect(lease.store.order).toEqual(tail);
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.created",
      item: {
        type: "message",
        id: ItemId.parse("still-live"),
        agentId,
        role: "assistant",
        createdAt: 99,
        complete: true,
        synthetic: false,
        raw: [],
        parts: [{ type: "text", text: "Still live" }],
      },
    },
  ]);
  await when(
    lease.store.select(["order"], (reader) => reader.order.includes("still-live")),
    Boolean,
  );
  expect(lease.store.order).toHaveLength(5);
  lease.release();
});

// Mutation cases: ignoring the request target exclusivity, reply-thread validation or page
// size cap. Not executed (tests run at merge).
test("invalid jump targets fail locally and a correlated reply from another thread is rejected", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  await expect(client.itemsWindow({ threadId: "", aroundSeq: 1 })).rejects.toMatchObject({
    code: "protocol",
  });
  await expect(
    client.itemsWindow({ threadId: h.thread.id, aroundSeq: 1, turnOrdinal: 1 }),
  ).rejects.toMatchObject({ code: "protocol" });
  await expect(
    client.itemsWindow({ threadId: h.thread.id, aroundSeq: 1, before: 100, after: 100 }),
  ).rejects.toMatchObject({ code: "protocol" });
  faults.incoming = (message, frame, deliver) => {
    deliver(
      message.type === "items.window"
        ? JSON.stringify({ ...message, threadId: "another-thread" })
        : frame,
    );
  };
  await expect(client.itemsWindow({ threadId: h.thread.id, aroundSeq: 1 })).rejects.toMatchObject({
    code: "protocol",
  });
});

// Mutation cases: using the last update rather than the greatest cursor, leaking device state,
// bypassing durable commands or regressing a saved cursor. Not executed (tests run at merge).
test("coalesced read marks survive reload and remain independent for another device", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make();
  await ready(client);
  const head = h.daemon.store.headSeq();
  const first = client.markThreadRead({ threadId: h.thread.id, lastSeenSeq: head });
  const lower = client.markThreadRead({ threadId: h.thread.id, lastSeenSeq: 0 });
  scheduler.advance(100);
  const [a, b] = await Promise.all([first, lower]);
  expect(a.ok).toBe(true);
  expect(b.commandId).toBe(a.commandId);
  const marks = faults.sent
    .map((frame) => ClientMessage.parse(JSON.parse(frame)))
    .filter(
      (message) => message.type === "command" && message.command.payload.type === "thread.markRead",
    );
  expect(marks).toHaveLength(1);
  expect(await client.threadReadState({ threadId: h.thread.id })).toMatchObject({
    lastSeenSeq: head,
  });
  await client.close();
  const reloaded = h.make().client;
  const other = h.make({ deviceId: DeviceId.parse("another-device") }).client;
  await Promise.all([ready(reloaded), ready(other)]);
  expect(await reloaded.threadReadState({ threadId: h.thread.id })).toMatchObject({
    lastSeenSeq: head,
  });
  expect(await other.threadReadState({ threadId: h.thread.id })).toMatchObject({ lastSeenSeq: 0 });
});

// Mutation cases: keeping an aborted highest mark, failing to release coalescing capacity or
// leaving a pending mark unsettled on close. Not executed (tests run at merge).
test("aborting an unsent read mark removes its cursor and closing rejects unsent marks", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, scheduler } = h.make();
  await ready(client);
  const controller = new AbortController();
  const high = client.markThreadRead(
    { threadId: h.thread.id, lastSeenSeq: h.daemon.store.headSeq() },
    { signal: controller.signal },
  );
  const aborted = expect(high).rejects.toMatchObject({ code: "aborted" });
  const low = client.markThreadRead({ threadId: h.thread.id, lastSeenSeq: 0 });
  controller.abort();
  await aborted;
  scheduler.advance(100);
  await low;
  expect(await client.threadReadState({ threadId: h.thread.id })).toMatchObject({ lastSeenSeq: 0 });
  const pending = client.markThreadRead({ threadId: h.thread.id, lastSeenSeq: 1 });
  const closed = expect(pending).rejects.toMatchObject({ code: "offline" });
  await client.close();
  await closed;
});

// Mutation cases: losing the initiating user message, treating root completion as whole-tree
// completion, or routing catch-up to a provider. Not executed (tests run at merge).
test("turn pages and deterministic catch-up retain a root outcome while its child is working", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const childId = AgentId.parse("long-child");
  const rootId = h.thread.rootAgentId ?? agentId;
  const runId = RunId.parse("long-turn");
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "agent.created",
      agent: {
        id: rootId,
        threadId: h.thread.id,
        parentId: null,
        origin: "root",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: h.directory,
        status: { state: "working", activity: "thinking" },
        createdAt: 1,
        background: false,
      },
    },
    {
      type: "item.created",
      item: {
        type: "message",
        id: ItemId.parse("initiating"),
        agentId: rootId,
        role: "user",
        createdAt: 2,
        complete: true,
        synthetic: false,
        raw: [],
        parts: [{ type: "text", text: "Work for days" }],
      },
    },
    {
      type: "run.started",
      run: {
        id: runId,
        threadId: h.thread.id,
        agentId: rootId,
        ordinal: 1,
        trigger: "user",
        state: "active",
        startedAt: 3,
      },
    },
    // Raw Store fixtures include the canonical status that Core emits separately.
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  const { client } = h.make();
  await ready(client);
  const page = await client.turnsPage({ threadId: h.thread.id });
  expect(page.turns[0]).toMatchObject({
    ordinal: 1,
    initiatingMessagePreview: "Work for days",
    outcome: "active",
  });
  expect(page.ready).toBe(true);
  const target = await client.itemsWindow({
    threadId: h.thread.id,
    turnOrdinal: 1,
    before: 0,
    after: 1,
  });
  expect(target.items[0]?.id).toBe("initiating");
  const catchUp = await client.threadCatchUp({ threadId: h.thread.id, sinceSeq: 0 });
  expect(catchUp.turnsCompleted).toBe(0);
  expect(catchUp.status.state).toBe("working");
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "agent.created",
      agent: {
        id: childId,
        threadId: h.thread.id,
        parentId: rootId,
        origin: "provider_subagent",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: h.directory,
        status: { state: "working", activity: "thinking" },
        createdAt: 4,
        background: true,
      },
    },
    { type: "run.ended", runId, state: "completed", endedAt: 5 },
    { type: "agent.status", agentId: rootId, status: { state: "idle" } },
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  const ended = await client.turnsPage({ threadId: h.thread.id });
  expect(ended.turns[0]).toMatchObject({ outcome: "completed", status: { state: "working" } });
  const stillWorking = await client.threadCatchUp({ threadId: h.thread.id, sinceSeq: 0 });
  expect(stillWorking.status.state).toBe("working");
  expect(stillWorking.turnsCompleted).toBe(0);
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "agent.status", agentId: childId, status: { state: "idle" } },
    { type: "thread.updated", status: { state: "done" } },
  ]);
  const completed = await client.threadCatchUp({ threadId: h.thread.id, sinceSeq: 0 });
  expect(completed.status).toEqual({ state: "done" });
  expect(completed.turnsCompleted).toBe(1);
});

// Mutation cases: retaining an unsent mark after disconnect, losing an accepted mark from the
// durable outbox, changing the command id on replay. Not executed (tests run at merge).
test("read marks never enter the outbox, including when their receipt is lost", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make({ storage: h.storage });
  await ready(client);
  const head = h.daemon.store.headSeq();
  const unsent = client.markThreadRead({ threadId: h.thread.id, lastSeenSeq: head });
  const disconnected = expect(unsent).rejects.toMatchObject({ code: "offline" });
  faults.disconnect();
  await disconnected;
  scheduler.advance(250);
  await when(client.connectionState(), (state) => state === "ready");
  expect(await client.threadReadState({ threadId: h.thread.id })).toMatchObject({
    lastSeenSeq: head,
  });
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "commandResult") deliver(frame);
  };
  const sent = client.markThreadRead({ threadId: h.thread.id, lastSeenSeq: head });
  const lostReceipt = expect(sent).rejects.toMatchObject({ code: "offline" });
  scheduler.advance(100);
  const receipt = await faults.wait((event) => event.type === "commandResult");
  if (receipt.type !== "commandResult") throw new Error("Expected read mark receipt");
  await client.close();
  await lostReceipt;
  const reloaded = h.make({ storage: h.storage }).client;
  await ready(reloaded);
  expect(reloaded.intent(receipt.commandId).getSnapshot()).toBeUndefined();
  expect(await h.storage.load()).toBeNull();
  expect(await reloaded.threadReadState({ threadId: h.thread.id })).toMatchObject({
    lastSeenSeq: head,
  });
});
