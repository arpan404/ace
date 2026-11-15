import { expect, test } from "vitest";
import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";
import { harness, hostId, memory, record, stored, thread, view } from "./read-snapshots.fixture.ts";

/*
 * How long a subscribe waits for the kept copy it would resume from. It goes as soon as the
 * read settles, found or not; a read still out holds it until the later of 250 ms after the
 * thread or list was opened and the client's first welcome, and not a moment longer.
 */

/** A kept list that can resume: it names the revision and epoch it was read at. */
const keptList = (title: string) => ({
  version: 2,
  home: {
    kind: "threads",
    seq: 10,
    threads: { thread: { ...thread, title } },
    window: { before: null, total: 1, counts: [], revision: 7, epoch: "db:activity:0" },
  },
});
/** Reads that answer only when the test resolves them, by key; `missing` keys answer at once. */
function heldDisk(missing: readonly string[] = []) {
  const pending = new Map<string, (value: unknown) => void>();
  const storage: ReadSnapshotStorage = {
    get: (key) =>
      missing.includes(key)
        ? Promise.resolve(undefined)
        : new Promise((resolve) => pending.set(key, resolve)),
    set: async () => {},
  };
  return { pending, storage };
}
/** Start the client and wait for its hello, holding the welcome back. */
async function helloOnly(f: ReturnType<typeof harness>) {
  await f.client.start();
  await expect.poll(() => f.sent.some((message) => message.type === "hello")).toBe(true);
}
const welcome = (f: ReturnType<typeof harness>) =>
  f.deliver({ type: "welcome", hostId, protocolVersion: 1, headSeq: 10, databaseId: "db-1" });
const subscribes = (f: ReturnType<typeof harness>, kind: "thread" | "threads") =>
  f.sent.filter((message) => message.type === "subscribe" && message.scope.kind === kind);

test("kept copies read before the welcome resume in subscribes that go ahead of it", async () => {
  const m = memory();
  m.values.set(stored("thread:thread"), record(view("Kept"), "db-1"));
  m.values.set(stored("sidebar:[null,false]"), keptList("Kept"));
  const f = harness(m.storage);
  f.client.thread("thread");
  const collection = f.client.threadsCollection();
  collection.threads();
  await helloOnly(f);
  // No welcome yet: both went with the hello, each from what it kept.
  await expect.poll(() => subscribes(f, "thread").length).toBe(1);
  await expect.poll(() => subscribes(f, "threads").length).toBe(1);
  const [opened] = subscribes(f, "thread");
  expect(opened?.type === "subscribe" ? opened.afterSeq : undefined).toBe(10);
  const [listed] = subscribes(f, "threads");
  const window =
    listed?.type === "subscribe" && listed.scope.kind === "threads"
      ? listed.scope.window
      : undefined;
  expect(window?.resume).toEqual({ revision: 7, epoch: "db:activity:0" });
  collection.close();
  await f.client.close();
});

test("a kept read still out holds subscribes until 250 ms after the open when the welcome came first", async () => {
  const disk = heldDisk();
  const f = harness(disk.storage);
  f.client.thread("thread");
  const collection = f.client.threadsCollection();
  collection.threads();
  await f.start("db-1");
  await Promise.resolve();
  expect(subscribes(f, "thread")).toHaveLength(0);
  expect(subscribes(f, "threads")).toHaveLength(0);
  f.elapse(250);
  await expect.poll(() => subscribes(f, "thread").length).toBe(1);
  await expect.poll(() => subscribes(f, "threads").length).toBe(1);
  // Gone without the copy: from no cursor, for the whole list.
  const [opened] = subscribes(f, "thread");
  expect(opened?.type === "subscribe" ? opened.afterSeq : 0).toBeUndefined();
  collection.close();
  await f.client.close();
});

test("a kept read still out holds subscribes past 250 ms only until the welcome, not a moment longer", async () => {
  const disk = heldDisk();
  const f = harness(disk.storage);
  f.client.thread("thread");
  const collection = f.client.threadsCollection();
  collection.threads();
  await helloOnly(f);
  f.elapse(250);
  await Promise.resolve();
  // The welcome has not come: what was kept may still be read in time to resume.
  expect(subscribes(f, "thread")).toHaveLength(0);
  expect(subscribes(f, "threads")).toHaveLength(0);
  welcome(f);
  // At the welcome they go, with no further wait.
  await expect.poll(() => subscribes(f, "thread").length).toBe(1);
  await expect.poll(() => subscribes(f, "threads").length).toBe(1);
  collection.close();
  await f.client.close();
});

test("a launch that restores a project filter waits for that filter's kept list, and resumes it", async () => {
  // The all-projects list was never kept; the selected project's is slow to read.
  const disk = heldDisk([stored("sidebar:[null,false]")]);
  const f = harness(disk.storage);
  const collection = f.client.threadsCollection();
  collection.threads();
  void collection.threadsWindow({ project: "selected" });
  await helloOnly(f);
  await Promise.resolve();
  // The first filter's read is in, but the list is for the selected project: it waits.
  expect(subscribes(f, "threads")).toHaveLength(0);
  disk.pending.get(stored('sidebar:["selected",false]'))?.(keptList("Selected"));
  await expect.poll(() => subscribes(f, "threads").length).toBe(1);
  const [listed] = subscribes(f, "threads");
  const window =
    listed?.type === "subscribe" && listed.scope.kind === "threads"
      ? listed.scope.window
      : undefined;
  expect(window?.project).toBe("selected");
  expect(window?.resume).toEqual({ revision: 7, epoch: "db:activity:0" });
  collection.close();
  await f.client.close();
});
