import { once } from "node:events";
import { Item } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { fixture } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  return f;
}

test("authenticated wire queries see committed appends and progress without writing command receipts", async () => {
  const f = await setup();
  const client = await f.connect();
  await client.next();
  const item = Item.parse({
    id: "searchitem",
    agentId: "agent",
    type: "message",
    role: "assistant",
    complete: true,
    createdAt: 1,
    parts: [{ type: "text", text: "wireword" }],
  });
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
  client.send({
    type: "search.query",
    requestId: "query",
    text: "wireword",
    mode: "tokens",
    scope: "items",
    filters: { workspaceId: f.workspace },
    limit: 30,
  });
  expect(await client.next()).toMatchObject({
    type: "search.results",
    requestId: "query",
    hits: [
      {
        threadId: f.thread.id,
        itemId: item.id,
        snippet: { text: "wireword", highlights: [{ start: 0, end: 8 }] },
      },
    ],
  });
  client.send({ type: "search.status", requestId: "status" });
  expect(await client.next()).toMatchObject({
    type: "search.progress",
    requestId: "status",
    indexedSeq: 2,
    headSeq: 2,
    pending: 0,
    ready: true,
  });
  expect(f.store.headSeq()).toBe(2);
  client.send({
    type: "search.query",
    requestId: "short",
    text: "xx",
    mode: "substring",
    scope: "items",
    filters: {},
    limit: 30,
  });
  expect(await client.next()).toEqual({
    type: "search.error",
    requestId: "short",
    code: "search_invalid_query",
  });
  client.send({ type: "ping" });
  expect(await client.next()).toEqual({ type: "pong" });
});

test("unauthenticated search is rejected before any search data is disclosed", async () => {
  const f = await setup();
  const client = await f.open();
  const closed = once(client.socket, "close");
  client.send({ type: "search.status", requestId: "secret" });
  expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
  expect((await closed)[0]).toBe(4001);
});

test("an item deletion removes search hits and the subscribed transcript together", async () => {
  const f = await setup();
  const item = Item.parse({
    id: "deleteditem",
    agentId: "agent",
    type: "message",
    role: "assistant",
    complete: true,
    createdAt: 1,
    parts: [{ type: "text", text: "deleteme" }],
  });
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
  const view = f.store.snapshotThread(f.thread.id);
  expect(view.items[item.id]).toBeDefined();
  f.store.appendEvents(f.thread.id, [{ type: "item.deleted", itemId: item.id }]);
  const deleted = f.store.snapshotThread(f.thread.id);
  expect(deleted.items[item.id]).toBeUndefined();
  expect(deleted.itemOrder).not.toContain(item.id);
  expect(f.store.search.query({ text: "deleteme" }).hits).toEqual([]);
});

test("daemon timer coalesces independent stream appends and flushes without waiting for completion", async () => {
  vi.useFakeTimers();
  const { Store } = await import("./store.ts");
  const store = new Store(":memory:");
  try {
    const workspaceId = store.createWorkspace("/timer", "Timer", 1);
    const { Thread } = await import("@ace/protocol");
    const thread = Thread.parse({
      id: "timerthread",
      workspaceId,
      provider: "codex",
      title: "Timer",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    const item = Item.parse({
      id: "timeritem",
      agentId: "agent",
      type: "message",
      role: "assistant",
      complete: false,
      createdAt: 1,
      parts: [],
    });
    store.appendEvents(thread.id, [
      { type: "thread.created", thread },
      { type: "item.created", item },
    ]);
    for (const append of ["timer", "word"])
      store.appendEvents(thread.id, [
        { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append },
      ]);
    const writes = store.search.status(store.headSeq()).indexWrites;
    expect(store.search.query({ text: "timerword" }).hits).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.search.query({ text: "timerword" }).hits[0]?.itemId).toBe(item.id);
    expect(store.search.status(store.headSeq()).indexWrites).toBe(writes + 1);
  } finally {
    store.close();
    vi.useRealTimers();
  }
});

test("startup backfill shows current working status even before replay reaches its latest event", async () => {
  const f = await setup();
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
  f.store.appendEvents(
    f.thread.id,
    Array.from({ length: 300 }, (_, i) => ({
      type: "item.created" as const,
      item: Item.parse({
        id: `history${i}`,
        agentId: "agent",
        type: "message",
        role: "assistant",
        complete: true,
        createdAt: 1,
        parts: [{ type: "text", text: "startupword" }],
      }),
    })),
  );
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", title: "Current title", status: { state: "working", agents: 1 } },
  ]);
  f.store.close();
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  const path = join(f.home, "events.sqlite");
  const db = new DatabaseSync(path);
  try {
    for (const name of ["search_prose", "search_titles", "search_trigram", "search_title_trigram"])
      db.exec(`INSERT INTO ${name}(${name}) VALUES ('delete-all')`);
    db.exec(
      "DELETE FROM search_stage; DELETE FROM search_docs; DELETE FROM search_threads; UPDATE search_meta SET seq=0",
    );
  } finally {
    db.close();
  }
  const { Store } = await import("./store.ts");
  const reopened = new Store(path);
  try {
    expect(reopened.search.status(reopened.headSeq()).ready).toBe(false);
    const results = reopened.search.query({ text: "startupword", filters: { status: "working" } });
    expect(results.hits).toHaveLength(30);
    expect(results.hits[0]?.threadTitle).toBe("Current title");
    expect(
      reopened.search.query({ text: "startupword", filters: { status: "done" } }).hits,
    ).toEqual([]);
  } finally {
    reopened.close();
  }
});
