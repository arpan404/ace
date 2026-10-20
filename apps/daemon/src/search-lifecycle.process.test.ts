import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Store } from "./index.ts";

test("a scheduler startup failure releases the store database", () => {
  const db = new DatabaseSync(":memory:");
  expect(
    () =>
      new Store(":memory:", () => {}, {
        database: db,
        searchScheduler: () => {
          throw new Error("scheduler unavailable");
        },
      }),
  ).toThrow("scheduler unavailable");
  expect(db.isOpen).toBe(false);
});

test("a scheduler cancellation failure closes the database and reports failed cleanup", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", () => {}, {
    database: db,
    searchScheduler: () => () => {
      throw new Error("cancel failed");
    },
  });
  await expect(store.close()).rejects.toThrow("cancel failed");
  expect(db.isOpen).toBe(false);
  await expect(store.close()).rejects.toThrow("cancel failed");
});

test("reentrant scheduler cancellation still closes the store once and releases its database", async () => {
  const db = new DatabaseSync(":memory:");
  let reentrant: Promise<void> | undefined;
  const store = new Store(":memory:", () => {}, {
    database: db,
    searchScheduler: () => () => {
      reentrant = store.close();
    },
  });
  await store.close();
  await reentrant;
  expect(db.isOpen).toBe(false);
});

test("streamed text becomes searchable on a periodic refresh, and settled search stops polling until more streams", async () => {
  const { Thread, Item, AgentId } = await import("@ace/protocol");
  let tick: (() => void) | undefined;
  const store = new Store(":memory:", () => {}, {
    searchScheduler: (run) => {
      tick = run;
      return () => {
        tick = undefined;
      };
    },
  });
  try {
    tick?.();
    expect(tick).toBeUndefined();
    const workspaceId = store.createWorkspace("/synthetic-search", "Search", 1);
    const thread = Thread.parse({
      id: "search-idle",
      workspaceId,
      provider: "codex",
      title: "Search",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    const item = Item.parse({
      id: "idle-item",
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
    store.appendEvents(thread.id, [
      {
        type: "item.delta",
        itemId: item.id,
        agentId: AgentId.parse(item.agentId),
        field: "text",
        append: "wokenneedle",
      },
    ]);
    // A streaming item is not rewritten on every pass, but within one refresh period.
    tick?.();
    expect(store.search.query({ text: "wokenneedle" }).hits).toEqual([]);
    expect(tick).toBeDefined();
    for (let pass = 0; pass < 20; pass++) {
      const run = tick;
      if (!run) break;
      run();
    }
    expect(store.search.query({ text: "wokenneedle" }).hits).toMatchObject([{ itemId: item.id }]);
    expect(tick).toBeUndefined();
    store.appendEvents(thread.id, [
      {
        type: "item.delta",
        itemId: item.id,
        agentId: AgentId.parse(item.agentId),
        field: "text",
        append: " laterneedle",
      },
    ]);
    for (let pass = 0; pass < 20; pass++) {
      const run = tick;
      if (!run) break;
      run();
    }
    expect(store.search.query({ text: "laterneedle" }).hits).toMatchObject([{ itemId: item.id }]);
    expect(tick).toBeUndefined();
  } finally {
    await store.close();
  }
});
