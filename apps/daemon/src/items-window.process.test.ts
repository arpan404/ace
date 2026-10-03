import { Agent, BackgroundTask, Interaction, ThreadId, Run, AgentItem } from "@ace/protocol";
import { applyDelivery, applyItemsPage, trackItem } from "@ace/projection";
import { afterEach, expect, it } from "vitest";
import { fixture } from "./socket-test-support.ts";
import type { Store } from "./index.ts";
import type { Item } from "@ace/protocol";
import { message } from "./payload-test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  return f;
}

function completeMessage(store: Store, item: Item) {
  if (item.type !== "message") throw new Error("Expected message");
  return {
    ...item,
    parts: item.parts.map((part) => {
      if (part.type !== "text" || !part.source) return part;
      const { source, ...preview } = part;
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < source.bytes) {
        const chunk = store.readOutput(source.streamId, offset, 256 * 1024);
        if (chunk.nextOffset <= offset) throw new Error("Source stalled");
        chunks.push(Buffer.from(chunk.bytes, "base64"));
        offset = chunk.nextOffset;
      }
      expect(offset).toBe(source.bytes);
      const text = Buffer.concat(chunks).toString("utf16le");
      expect(preview.text).toBe(text.slice(0, preview.text.length));
      return { ...preview, text };
    }),
  };
}
it("snapshots only the last 200 items, keeps all work entities and pages older history in creation order", async () => {
  const f = await setup();
  const agent = Agent.parse({
    id: "root",
    threadId: f.thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "idle" },
    createdAt: 1,
  });
  const run = Run.parse({
    id: "run",
    threadId: f.thread.id,
    agentId: agent.id,
    trigger: "user",
    state: "active",
    startedAt: 1,
  });
  const interaction = Interaction.parse({
    id: "question",
    threadId: f.thread.id,
    agentId: agent.id,
    blocking: true,
    request: { kind: "approval", title: "Allow", options: [] },
    state: "pending",
    createdAt: 1,
  });
  const task = BackgroundTask.parse({
    id: "task",
    agentId: agent.id,
    kind: "shell",
    title: "Build",
    status: "running",
    stoppable: true,
    startedAt: 1,
  });
  f.store.appendEvents(f.thread.id, [
    { type: "agent.created", agent },
    { type: "run.started", run },
    { type: "interaction.opened", interaction },
    { type: "background_task.started", task },
  ]);
  f.store.appendEvents(
    f.thread.id,
    Array.from({ length: 250 }, (_, i) => ({
      type: "item.created" as const,
      item: message(`item-${i}`),
    })),
  );
  f.store.appendEvents(f.thread.id, [
    { type: "item.updated", item: message("item-0", "late update") },
  ]);
  const c = await f.connect();
  await c.next();
  c.send({
    type: "subscribe",
    subscriptionId: "s",
    scope: { kind: "thread", threadId: f.thread.id },
  });
  const snapshot = await c.next();
  if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread")
    throw new Error("Expected thread snapshot");
  const view = snapshot.view;
  expect(view.itemOrder).toEqual(Array.from({ length: 200 }, (_, i) => `item-${i + 50}`));
  expect(view.itemsBefore).toBe(56);
  expect(view.agents.root).toEqual(agent);
  expect(view.runs.run).toEqual(run);
  expect(view.interactions.question).toEqual(interaction);
  expect(view.backgroundTasks.task).toEqual(task);
  c.send({
    type: "items.page",
    requestId: "page",
    threadId: f.thread.id,
    before: view.itemsBefore!,
    limit: 30,
  });
  const page = await c.next();
  if (page.type !== "items.page") throw new Error("Expected page");
  expect(page.items.map((item) => item.id)).toEqual(
    Array.from({ length: 30 }, (_, i) => `item-${i + 20}`),
  );
  expect(page.itemsBefore).toBe(26);
  applyItemsPage(view, page);
  const last = f.store.readItems(f.thread.id, page.itemsBefore!, 200);
  expect(last.items.map((item) => item.id)).toEqual(
    Array.from({ length: 20 }, (_, i) => `item-${i}`),
  );
  expect(last.items[0]).toMatchObject({ parts: [{ text: "late update" }] });
  expect(last.itemsBefore).toBeNull();
  applyItemsPage(view, last);
  expect(view.itemOrder).toHaveLength(250);
  expect(new Set(view.itemOrder).size).toBe(250);
  expect(view.seq).toBe(snapshot.seq);
});
it("keeps snapshots within the item byte budget and permits paging a single oversized item", async () => {
  const f = await setup();
  f.store.appendEvents(
    f.thread.id,
    Array.from({ length: 100 }, (_, i) => ({
      type: "item.created" as const,
      item: message(`item-${i}`, "é".repeat(20 * 1024)),
    })),
  );
  const view = f.store.snapshotThread(f.thread.id);
  expect(view.itemOrder.length).toBeGreaterThan(0);
  expect(view.itemOrder.length).toBeLessThan(100);
  expect(Buffer.byteLength(JSON.stringify(Object.values(view.items)))).toBeLessThanOrEqual(
    1024 * 1024,
  );
  expect(view.itemOrder.at(-1)).toBe("item-99");
  expect(view.itemsBefore).not.toBeNull();
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item: message("huge", "x".repeat(2 * 1024 * 1024)) },
  ]);
  const empty = f.store.snapshotThread(f.thread.id);
  expect(empty.itemOrder).toEqual([]);
  expect(empty.itemsBefore).toBe(f.store.headSeq() + 1);
  const page = f.store.readItems(f.thread.id, empty.itemsBefore!, 1);
  expect(page.items[0]?.id).toBe("huge");
  expect(page.itemsBefore).not.toBeNull();
});
it("pages several oversized messages one at a time over the socket without skipping history", async () => {
  const f = await setup();
  const text = "x".repeat(2 * 1024 * 1024);
  const items = Array.from({ length: 4 }, (_, i) => message(`huge-${i}`, text));
  const events = f.store.appendEvents(
    f.thread.id,
    items.map((item) => ({ type: "item.created", item })),
  );
  const snapshot = f.store.snapshotThread(f.thread.id);
  expect(snapshot.itemOrder).toEqual([]);
  let before = snapshot.itemsBefore;
  const c = await f.connect();
  await c.next();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const event = events[i];
    if (!item || !event || before === null) throw new Error("History ended too early");
    c.send({ type: "items.page", requestId: `p-${i}`, threadId: f.thread.id, before, limit: 1 });
    const page = await c.next();
    if (page.type !== "items.page") throw new Error("Expected page");
    expect(page.items).toHaveLength(1);
    expect(page.items.map((entry) => completeMessage(f.store, entry))).toEqual([item]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024);
    expect(page.itemsBefore).toBe(i ? event.seq : null);
    before = page.itemsBefore;
  }
  expect(before).toBeNull();
});
it("bounds aggregate history pages using appended UTF-8 text and JSON escaping", async () => {
  const f = await setup();
  const text = "é\0".repeat(96 * 1024);
  const items = Array.from({ length: 3 }, (_, i) => message(`appended-${i}`, ""));
  for (const item of items)
    f.store.appendEvents(f.thread.id, [
      { type: "item.created", item },
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: text },
    ]);
  let before: number | null = f.store.headSeq() + 1;
  for (const item of items.toReversed()) {
    if (before === null) throw new Error("History ended too early");
    const page = f.store.readItems(f.thread.id, before, 200);
    expect(page.items).toEqual([message(item.id, text)]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024);
    if (page.itemsBefore !== null) expect(page.itemsBefore).toBeLessThan(before);
    before = page.itemsBefore;
  }
  expect(before).toBeNull();
});
it("ignores unloaded updates and deltas, follows tracked details and preserves newer values when paging", async () => {
  const f = await setup();
  f.store.appendEvents(
    f.thread.id,
    Array.from({ length: 201 }, (_, i) => ({
      type: "item.created" as const,
      item: message(`item-${i}`),
    })),
  );
  const c = await f.connect();
  await c.next();
  c.send({
    type: "subscribe",
    subscriptionId: "s",
    scope: { kind: "thread", threadId: f.thread.id },
  });
  const snapshot = await c.next();
  if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread")
    throw new Error("Expected thread snapshot");
  const view = snapshot.view;
  const oldPage = f.store.readItems(f.thread.id, view.itemsBefore!, 1);
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item: message("live", "live creation") },
  ]);
  const created = await c.next();
  if (created.type !== "events") throw new Error("Expected events");
  applyDelivery(view, created);
  expect(view.items.live).toMatchObject({ parts: [{ text: "live creation" }] });
  expect(view.itemOrder.at(-1)).toBe("live");

  const update = (id: string, text: string) =>
    f.store.appendEvents(f.thread.id, [{ type: "item.updated", item: message(id, text) }]);
  update("item-0", "ignored");
  const ignored = await c.next();
  if (ignored.type !== "events") throw new Error("Expected events");
  expect(applyDelivery(view, ignored).kind).toBe("applied");
  expect(view.items["item-0"]).toBeUndefined();
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.delta",
      itemId: message("item-0").id,
      agentId: message("item-0").agentId,
      field: "text",
      append: " ignored delta",
    },
  ]);
  const delta = await c.next();
  if (delta.type !== "events") throw new Error("Expected events");
  applyDelivery(view, delta);
  expect(view.items["item-0"]).toBeUndefined();
  trackItem(view, oldPage.items[0]!);
  update("item-0", "tracked");
  const tracked = await c.next();
  if (tracked.type !== "events") throw new Error("Expected events");
  applyDelivery(view, tracked);
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.delta",
      itemId: message("item-0").id,
      agentId: message("item-0").agentId,
      field: "text",
      append: " detail delta",
    },
  ]);
  const detailDelta = await c.next();
  if (detailDelta.type !== "events") throw new Error("Expected events");
  applyDelivery(view, detailDelta);
  applyItemsPage(view, oldPage);
  expect(view.items["item-0"]).toMatchObject({ parts: [{ text: "tracked detail delta" }] });
  expect(view.itemOrder[0]).toBe("item-0");
  expect(view.itemsBefore).toBeNull();
  update("new", "new live item"); // Unknown updates after paging all history are authoritative.
  const newest = await c.next();
  if (newest.type !== "events") throw new Error("Expected events");
  applyDelivery(view, newest);
  expect(view.items.new).toMatchObject({ parts: [{ text: "new live item" }] });
  expect(() => applyItemsPage(view, { ...oldPage, threadId: ThreadId.parse("wrong") })).toThrow(
    "scope",
  );
});

it("retains no historical transcript in a subscribed status cache, including after live creations", async () => {
  const f = await setup();
  f.store.appendEvents(
    f.thread.id,
    Array.from({ length: 2000 }, (_, i) => ({
      type: "item.created" as const,
      item: message(`history-${i}`, "x".repeat(4096)),
    })),
  );
  const c = await f.connect();
  await c.next();
  c.send({
    type: "subscribe",
    subscriptionId: "s",
    scope: { kind: "thread", threadId: f.thread.id },
  });
  const snapshot = await c.next();
  if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread")
    throw new Error("Expected snapshot");
  expect(snapshot.view.itemOrder).toHaveLength(200);
  const retained = f.store.acquireThread(f.thread.id);
  try {
    expect(retained.itemOrder).toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThan(1024 * 1024);
    f.store.appendEvents(f.thread.id, [{ type: "item.created", item: message("live") }]);
    expect(await c.next()).toMatchObject({ type: "events" });
    expect(retained.itemOrder).toHaveLength(0);
  } finally {
    f.store.releaseThread(f.thread.id);
  }
});
it("accounts for item record keys and ordering ids within the snapshot byte budget", async () => {
  const f = await setup();
  const id = "i".repeat(8000);
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item: message(id, "x".repeat(1024 * 1024 - 9000)) },
  ]);
  const view = f.store.snapshotThread(f.thread.id);
  expect(
    Buffer.byteLength(JSON.stringify(view.items)) +
      Buffer.byteLength(JSON.stringify(view.itemOrder)),
  ).toBeLessThanOrEqual(1024 * 1024);
  expect(f.store.readItems(f.thread.id, f.store.headSeq() + 1, 1).items[0]?.id).toBe(id);
});

it("budgets appended message text including a newly created text part and JSON escaping", async () => {
  const f = await setup();
  const item = AgentItem.parse({ ...message("m"), parts: [{ type: "file", path: "/repo/file" }] });
  const initialBytes =
    Buffer.byteLength(JSON.stringify({ m: item })) + Buffer.byteLength(JSON.stringify(["m"]));
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item },
    {
      type: "item.delta",
      itemId: item.id,
      agentId: item.agentId,
      field: "text",
      append: "x".repeat(1024 * 1024 - initialBytes - 1),
    },
  ]);
  expect(f.store.snapshotThread(f.thread.id).itemOrder).toEqual([]);
  const text = "\0".repeat((1024 * 1024) / 8);
  f.store.appendEvents(f.thread.id, [
    { type: "item.updated", item: message("m", "") },
    {
      type: "item.delta",
      itemId: item.id,
      agentId: item.agentId,
      field: "text",
      append: text,
    },
  ]);
  const view = f.store.snapshotThread(f.thread.id);
  expect(view.items.m).toMatchObject({ parts: [{ text }] });
  expect(
    Buffer.byteLength(JSON.stringify(view.items)) +
      Buffer.byteLength(JSON.stringify(view.itemOrder)),
  ).toBeLessThanOrEqual(1024 * 1024);
  f.store.appendEvents(f.thread.id, [
    { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: text },
  ]);
  expect(f.store.snapshotThread(f.thread.id).itemOrder).toEqual([]);
  expect(f.store.readItems(f.thread.id, f.store.headSeq() + 1, 1).items[0]).toMatchObject({
    parts: [{ text: text + text }],
  });
});
