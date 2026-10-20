import { expect, test } from "vitest";
import type { ReadSnapshotStorage } from "./index.ts";
import { harness, memory, stored, thread } from "./read-snapshots.fixture.ts";

/** A thread-list row in `project`. */
const row = (id: string, project: string, title = id) => ({
  ...thread,
  id,
  workspaceId: project,
  title,
});
/** A list holding `rows`; `paged` says the daemon holds older rows back. */
const listOf = (rows: readonly ReturnType<typeof row>[], options: { paged?: boolean } = {}) => ({
  kind: "threads",
  seq: 10,
  threads: Object.fromEntries(rows.map((entry) => [entry.id, entry])),
  window: {
    before: options.paged ? { at: 1, id: "older" } : null,
    total: rows.length + (options.paged ? 20 : 0),
    counts: [],
  },
});
/** Disk reads that answer only when a test resolves them, by key. */
function slowDisk() {
  const pending = new Map<string, (value: unknown) => void>();
  return {
    pending,
    storage: {
      get: (key: string) => new Promise<unknown>((resolve) => pending.set(key, resolve)),
      set: async () => {},
    },
  };
}

async function sidebar(storage: ReadSnapshotStorage = slowDisk().storage) {
  const f = harness(storage);
  const collection = f.client.threadsCollection();
  const lease = collection.threads();
  await f.start();
  /** The daemon's snapshot of `view`, by default on the latest list subscription. */
  const snapshot = (view: { seq: number }, subscriptionId = f.wire("threads").subscriptionId) =>
    f.deliver({ type: "snapshot", subscriptionId, seq: view.seq, view });
  return { f, collection, store: lease.store, snapshot };
}

const all = [row("relay-1", "relay"), row("web-1", "web"), row("relay-2", "relay")];

test("switching back to a project seen this session paints its rows at once until its snapshot confirms them", async () => {
  const { f, collection, store, snapshot } = await sidebar();
  snapshot(listOf(all));
  await collection.threadsWindow({ project: "web" });
  snapshot(listOf([row("web-1", "web", "Web live"), row("web-2", "web")]));
  expect(store.unconfirmed).toBe(false);
  await collection.threadsWindow({ project: "relay" });
  await collection.threadsWindow({ project: "web" });
  // Painted from this session's list, before the new subscription's snapshot.
  expect(store.loaded).toBe(true);
  expect(store.ids).toEqual(["web-1", "web-2"]);
  expect(store.thread("web-1")?.title).toBe("Web live");
  expect(store.unconfirmed).toBe(true);
  expect(store.syncing).toBe(true);
  snapshot(listOf([row("web-2", "web"), row("web-3", "web")]));
  expect(store.ids).toEqual(["web-2", "web-3"]);
  expect(store.unconfirmed).toBe(false);
  expect(store.syncing).toBe(false);
  collection.close();
  await f.client.close();
});

test("switching from all projects to one never seen paints its held rows, unconfirmed and without a page cursor", async () => {
  const { f, collection, store, snapshot } = await sidebar();
  snapshot(listOf(all, { paged: true }));
  await collection.threadsWindow({ project: "relay" });
  expect(store.loaded).toBe(true);
  expect(store.ids).toEqual(["relay-1", "relay-2"]);
  expect(store.unconfirmed).toBe(true);
  expect(store.syncing).toBe(true);
  // The all-projects window's cursor and total say nothing about this project's list.
  expect(store.window).toBeUndefined();
  expect(store.homeWindow).toBeUndefined();
  await collection.threadsMore();
  expect(f.sent.some((message) => message.type === "threads.page")).toBe(false);
  snapshot(listOf([row("relay-2", "relay")]));
  expect(store.ids).toEqual(["relay-2"]);
  expect(store.unconfirmed).toBe(false);
  expect(store.window?.total).toBe(1);
  collection.close();
  await f.client.close();
});

test("a project with no held rows waits for its own list unless the held list was whole", async () => {
  const paged = await sidebar();
  paged.snapshot(listOf(all, { paged: true }));
  await paged.collection.threadsWindow({ project: "docs" });
  // Older rows the daemon still holds back may be this project's: no rows is no evidence.
  expect(paged.store.loaded).toBe(false);
  paged.collection.close();
  await paged.f.client.close();

  const whole = await sidebar();
  whole.snapshot(listOf(all));
  await whole.collection.threadsWindow({ project: "docs" });
  expect(whole.store.loaded).toBe(true);
  expect(whole.store.ids).toEqual([]);
  expect(whole.store.unconfirmed).toBe(true);
  whole.collection.close();
  await whole.f.client.close();
});

test("widening from one project to all with nothing remembered waits for the daemon", async () => {
  const { f, collection, store, snapshot } = await sidebar();
  await collection.threadsWindow({ project: "relay" });
  snapshot(listOf([row("relay-1", "relay")]));
  await collection.threadsWindow({});
  expect(store.loaded).toBe(false);
  collection.close();
  await f.client.close();
});

test("the filter's disk record replaces a derived list, and the daemon's snapshot replaces both", async () => {
  const disk = slowDisk();
  const { f, collection, store, snapshot } = await sidebar(disk.storage);
  snapshot(listOf(all));
  await collection.threadsWindow({ project: "relay" });
  expect(store.ids).toEqual(["relay-1", "relay-2"]);
  disk.pending.get(stored('sidebar:["relay",false]'))?.({
    version: 2,
    home: listOf([row("relay-1", "relay", "From disk"), row("relay-9", "relay")]),
  });
  await expect.poll(() => store.ids).toEqual(["relay-1", "relay-9"]);
  expect(store.thread("relay-1")?.title).toBe("From disk");
  expect(store.unconfirmed).toBe(true);
  snapshot(listOf([row("relay-1", "relay", "Live")]));
  expect(store.ids).toEqual(["relay-1"]);
  expect(store.thread("relay-1")?.title).toBe("Live");
  expect(store.unconfirmed).toBe(false);
  collection.close();
  await f.client.close();
});

test("a list remembered this session is never replaced by the filter's older disk record", async () => {
  const disk = slowDisk();
  const { f, collection, store, snapshot } = await sidebar(disk.storage);
  await collection.threadsWindow({ project: "web" });
  snapshot(listOf([row("web-1", "web", "Remembered")]));
  await collection.threadsWindow({ project: "relay" });
  await collection.threadsWindow({ project: "web" });
  const reads = [...disk.pending].filter(([key]) => key === stored('sidebar:["web",false]'));
  for (const [, resolve] of reads)
    resolve({ version: 2, home: listOf([row("web-1", "web", "Disk")]) });
  await Promise.resolve();
  await Promise.resolve();
  expect(store.thread("web-1")?.title).toBe("Remembered");
  collection.close();
  await f.client.close();
});

test("a late snapshot or patch for the previous filter never lands on a provisional list", async () => {
  const { f, collection, store, snapshot } = await sidebar();
  snapshot(listOf(all));
  const previous = f.wire("threads").subscriptionId;
  await collection.threadsWindow({ project: "relay" });
  snapshot(listOf([row("web-1", "web", "Late")]), previous);
  f.deliver({
    type: "threads.patch",
    subscriptionId: previous,
    seq: 11,
    threads: { "web-2": row("web-2", "web") },
    removed: ["relay-1"],
    window: { before: null, total: 3, counts: [] },
  });
  expect(store.ids).toEqual(["relay-1", "relay-2"]);
  expect(store.unconfirmed).toBe(true);
  collection.close();
  await f.client.close();
});

test("a derived list is never written as the filter's own record", async () => {
  const m = memory();
  const { f, collection, store, snapshot } = await sidebar(m.storage);
  snapshot(listOf(all));
  await collection.threadsWindow({ project: "relay" });
  expect(store.ids).toEqual(["relay-1", "relay-2"]);
  // A refused subscription changes the store, which would schedule a write of what it holds.
  f.deliver({
    type: "error",
    subscriptionId: f.wire("threads").subscriptionId,
    code: "unavailable",
    message: "Unavailable",
  });
  await expect.poll(() => store.error?.code).toBe("daemon");
  f.flush();
  collection.close();
  await f.client.close();
  expect(m.values.has(stored('sidebar:["relay",false]'))).toBe(false);
});

test("opening the archive again paints the archived rows it last showed", async () => {
  const { f, collection, store, snapshot } = await sidebar();
  snapshot(listOf([]));
  await collection.threadsWindow({ archived: true });
  // The archive's own subscription is the latest.
  snapshot(listOf([row("old", "relay", "Archived")]));
  expect(store.unconfirmed).toBe(false);
  await collection.threadsWindow({});
  expect(store.thread("old")).toBeUndefined();
  await collection.threadsWindow({ archived: true });
  expect(store.thread("old")?.title).toBe("Archived");
  expect(store.unconfirmed).toBe(true);
  collection.close();
  await f.client.close();
});
