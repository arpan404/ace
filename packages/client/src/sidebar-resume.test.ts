import { expect, test } from "vitest";
import { harness, hostId, memory, thread } from "./read-snapshots.fixture.ts";

/*
 * The thread list resumes from the revision it holds: after a reconnect or a filter switch it
 * asks the daemon only for what changed, keeps the rest as it was (places and all), and starts
 * over when the daemon keeps a thread it no longer holds.
 */

const placed = (id: string, project: string, tab: "inbox" | "settled", at: number) => ({
  ...thread,
  id,
  workspaceId: project,
  title: id,
  place: tab === "inbox" ? { tab, band: "idle", rank: [at] } : { tab, rank: [at] },
});
type Row = ReturnType<typeof placed>;
const listOf = (rows: readonly Row[], revision: number, keep?: readonly string[]) => ({
  kind: "threads",
  seq: 10,
  threads: Object.fromEntries(rows.map((entry) => [entry.id, entry])),
  window: { before: null, total: 0, counts: [], revision, epoch: "db:activity:0" },
  ...(keep ? { keep } : {}),
});

async function sidebar() {
  const f = harness(memory().storage);
  const collection = f.client.threadsCollection();
  const lease = collection.threads();
  await f.start();
  const snapshot = (view: { seq: number }) =>
    f.deliver({
      type: "snapshot",
      subscriptionId: f.wire("threads").subscriptionId,
      seq: 10,
      view,
    });
  const resumeAsked = () => {
    const wire = f.wire("threads");
    return wire.scope.kind === "threads" ? wire.scope.window?.resume : undefined;
  };
  return { f, collection, store: lease.store, snapshot, resumeAsked };
}

test("a reconnect resumes from the revision held: unchanged rows stay as they were, only moves arrive", async () => {
  const { f, collection, store, snapshot, resumeAsked } = await sidebar();
  expect(resumeAsked()).toBeUndefined();
  snapshot(listOf([placed("a", "p", "inbox", 3), placed("b", "p", "inbox", 2)], 7));
  const kept = store.thread("a");
  await f.reconnect(12);
  expect(resumeAsked()).toEqual({ revision: 7, epoch: "db:activity:0" });
  // While away, b was settled: the daemon sends b alone and names a as kept.
  snapshot(listOf([placed("b", "p", "settled", 2)], 9, ["a"]));
  expect(store.ids.toSorted()).toEqual(["a", "b"]);
  // The kept row is the very entry held: nothing about it re-renders.
  expect(store.thread("a")).toBe(kept);
  expect(store.thread("b")?.place?.tab).toBe("settled");
  expect(store.unconfirmed).toBe(false);
  collection.close();
  await f.client.close();
});

test("a resume that keeps a thread this list no longer holds starts over with the whole window", async () => {
  const { f, collection, store, snapshot, resumeAsked } = await sidebar();
  snapshot(listOf([placed("a", "p", "inbox", 3)], 7));
  await f.reconnect(12);
  const first = f.wire("threads").subscriptionId;
  snapshot(listOf([], 9, ["a", "unknown"]));
  // Asked again, without resume, on a new subscription.
  expect(f.wire("threads").subscriptionId).not.toBe(first);
  expect(resumeAsked()).toBeUndefined();
  snapshot(listOf([placed("a", "p", "inbox", 3), placed("unknown", "p", "inbox", 1)], 9));
  expect(store.ids.toSorted()).toEqual(["a", "unknown"]);
  collection.close();
  await f.client.close();
});

test("a remembered filter repaints its tabs as the daemon placed them, then resumes from its revision", async () => {
  const { f, collection, store, snapshot, resumeAsked } = await sidebar();
  snapshot(listOf([placed("a", "p", "inbox", 3), placed("s", "p", "settled", 1)], 4));
  await collection.threadsWindow({ project: "web" });
  snapshot(listOf([placed("w1", "web", "inbox", 5), placed("w2", "web", "settled", 4)], 6));
  await collection.threadsWindow({ project: "relay" });
  snapshot(listOf([], 6));
  await collection.threadsWindow({ project: "web" });
  // Painted at once from memory, with the daemon's places, before any snapshot.
  expect(store.unconfirmed).toBe(true);
  expect(store.thread("w1")?.place?.tab).toBe("inbox");
  expect(store.thread("w2")?.place?.tab).toBe("settled");
  expect(resumeAsked()).toEqual({ revision: 6, epoch: "db:activity:0" });
  // The live answer corrects it: w1 settled since.
  snapshot(listOf([placed("w1", "web", "settled", 5)], 8, ["w2"]));
  expect(store.unconfirmed).toBe(false);
  expect(store.thread("w1")?.place?.tab).toBe("settled");
  expect(store.ids.toSorted()).toEqual(["w1", "w2"]);
  collection.close();
  await f.client.close();
});

test("a resumed list takes the kept rows' read cursors the daemon sends with it", async () => {
  const { f, collection, store, snapshot } = await sidebar();
  const unread = { lastSeenSeq: 0, updatedAt: null };
  const first = listOf([placed("a", "p", "inbox", 3), placed("b", "p", "inbox", 2)], 7);
  const read = (row: Row | undefined) => ({ ...row, readState: unread });
  const opened = { ...first, threads: { a: read(first.threads.a), b: read(first.threads.b) } };
  snapshot(opened);
  await f.reconnect(12);
  // While away, this device read a on another socket: the row is kept, its cursor moved.
  const resumed = { ...listOf([], 9, ["a", "b"]), reads: { a: { lastSeenSeq: 9, updatedAt: 5 } } };
  snapshot(resumed);
  expect(store.thread("a")?.readState).toEqual({ lastSeenSeq: 9, updatedAt: 5 });
  expect(store.thread("b")?.readState).toEqual(unread);
  expect(store.thread("a")?.place?.tab).toBe("inbox");
  collection.close();
  await f.client.close();
});

/** Whether the list says it is the daemon's own current one, as the inbox reads it. */
const current = (store: { syncing: boolean; unconfirmed: boolean; error?: unknown }) =>
  !store.syncing && !store.unconfirmed && store.error === undefined;

test("a list subscribe the daemon turns down after a reconnect is asked again, and confirms on that socket", async () => {
  const { f, collection, store, snapshot } = await sidebar();
  snapshot(listOf([placed("a", "p", "inbox", 3)], 7));
  await f.reconnect(12);
  const refused = f.wire("threads").subscriptionId;
  f.deliver({ type: "error", subscriptionId: refused, code: "unavailable", message: "Busy" });
  await expect.poll(() => store.error?.code).toBe("daemon");
  // Refused is never current: the rows held are a copy the daemon hasn't confirmed.
  expect(store.unconfirmed).toBe(true);
  expect(store.syncing).toBe(true);
  // As a held thread's refusal is, the list's is asked again on the same socket.
  f.elapse(500);
  await expect.poll(() => f.wire("threads").subscriptionId).not.toBe(refused);
  expect(f.client.state).toBe("ready");
  // Asked again is not answered: still nothing current until the snapshot lands.
  expect(current(store)).toBe(false);
  expect(store.unconfirmed).toBe(true);
  snapshot(listOf([placed("a", "p", "settled", 3)], 9));
  expect(current(store)).toBe(true);
  expect(store.thread("a")?.place?.tab).toBe("settled");
  collection.close();
  await f.client.close();
});

/** The latest subscribe of the Home list (`archived` false) or the Archive's. */
function windowWire(f: Awaited<ReturnType<typeof sidebar>>["f"], archived: boolean) {
  const wire = f.sent.findLast(
    (message) =>
      message.type === "subscribe" &&
      message.scope.kind === "threads" &&
      (message.scope.window?.archived === true) === archived,
  );
  if (!wire || wire.type !== "subscribe") throw new Error("No subscription");
  return wire.subscriptionId;
}
const at = (
  f: Awaited<ReturnType<typeof sidebar>>["f"],
  archived: boolean,
  view: { seq: number },
) => f.deliver({ type: "snapshot", subscriptionId: windowWire(f, archived), seq: 10, view });

test("with the archive open, its snapshot never confirms a Home list the daemon turned down", async () => {
  const { f, collection, store } = await sidebar();
  await collection.threadsWindow({ archived: true });
  at(f, false, listOf([placed("a", "p", "inbox", 3)], 7));
  at(f, true, listOf([placed("old", "p", "settled", 1)], 7));
  expect(current(store)).toBe(true);
  await f.reconnect(12);
  f.deliver({
    type: "error",
    subscriptionId: windowWire(f, false),
    code: "unavailable",
    message: "Busy",
  });
  await expect.poll(() => store.error?.code).toBe("daemon");
  // The archive's own answer says nothing of Home's rows.
  at(f, true, listOf([placed("old", "p", "settled", 1)], 9));
  expect(store.error?.code).toBe("daemon");
  expect(current(store)).toBe(false);
  f.elapse(500);
  at(f, false, listOf([placed("a", "p", "settled", 3)], 9));
  expect(current(store)).toBe(true);
  collection.close();
  await f.client.close();
});

test("asking Home again leaves the archive's subscription alone, and Home keeps its own backoff", async () => {
  const { f, collection, store } = await sidebar();
  await collection.threadsWindow({ archived: true });
  at(f, false, listOf([placed("a", "p", "inbox", 3)], 7));
  at(f, true, listOf([placed("old", "p", "settled", 1)], 7));
  const archive = windowWire(f, true);
  const refuse = () =>
    f.deliver({
      type: "error",
      subscriptionId: windowWire(f, false),
      code: "unavailable",
      message: "Busy",
    });
  const homes = () =>
    f.sent.filter(
      (message) =>
        message.type === "subscribe" &&
        message.scope.kind === "threads" &&
        message.scope.window?.archived !== true,
    ).length;
  refuse();
  await expect.poll(() => store.error?.code).toBe("daemon");
  const before = homes();
  f.elapse(500);
  await expect.poll(homes).toBe(before + 1);
  // Only Home went again: the archive keeps its wire and the pages it loaded.
  expect(windowWire(f, true)).toBe(archive);
  expect(
    f.sent.some((message) => message.type === "unsubscribe" && message.subscriptionId === archive),
  ).toBe(false);
  // Refused again, Home waits longer; nothing the archive does resets that.
  refuse();
  f.elapse(500);
  expect(homes()).toBe(before + 1);
  f.elapse(1_000);
  await expect.poll(homes).toBe(before + 2);
  expect(windowWire(f, true)).toBe(archive);
  collection.close();
  await f.client.close();
});

test("asking the archive again never tells a watcher the list is current before its snapshot", async () => {
  const { f, collection, store } = await sidebar();
  at(f, false, listOf([placed("a", "p", "inbox", 3)], 7));
  // No archived rows were ever kept: opening the archive paints nothing from memory.
  await collection.threadsWindow({ archived: true });
  // A watcher keeps what it was last told, as a screen's freshness gate does.
  const syncing = store.select(["sync"], (list) => list.syncing);
  let told = syncing.getSnapshot();
  const stop = syncing.subscribe(() => {
    told = syncing.getSnapshot();
  });
  f.deliver({
    type: "error",
    subscriptionId: windowWire(f, true),
    code: "unavailable",
    message: "Busy",
  });
  await expect.poll(() => store.error?.code).toBe("daemon");
  expect(told).toBe(true);
  const refused = windowWire(f, true);
  f.elapse(500);
  await expect.poll(() => windowWire(f, true)).not.toBe(refused);
  // Asked again, not answered: the watcher still holds that the list is syncing.
  expect(told).toBe(true);
  expect(syncing.getSnapshot()).toBe(true);
  at(f, true, listOf([placed("old", "p", "settled", 1)], 9));
  expect(told).toBe(false);
  stop();
  collection.close();
  await f.client.close();
});

test("another project's Home list starts its own backoff, never the rest of the last project's wait", async () => {
  const { f, collection, store } = await sidebar();
  at(f, false, listOf([placed("a", "p", "inbox", 3)], 7));
  const refuse = () =>
    f.deliver({
      type: "error",
      subscriptionId: windowWire(f, false),
      code: "unavailable",
      message: "Busy",
    });
  // Refused three times here: the next ask waits 2 s.
  refuse();
  f.elapse(500);
  refuse();
  f.elapse(1_000);
  refuse();
  await expect.poll(() => store.error?.code).toBe("daemon");
  await collection.threadsWindow({ project: "web" });
  const web = windowWire(f, false);
  refuse();
  // The new project's first refusal is asked again after its own first wait.
  f.elapse(500);
  await expect.poll(() => windowWire(f, false)).not.toBe(web);
  const project = f.sent.findLast(
    (message) => message.type === "subscribe" && message.subscriptionId === windowWire(f, false),
  );
  expect(
    project?.type === "subscribe" &&
      project.scope.kind === "threads" &&
      project.scope.window?.project,
  ).toBe("web");
  collection.close();
  await f.client.close();
});

test("a welcome's late replay leaves a refused Home to its own retry and the archive's wire alone", async () => {
  // Saving the daemon's identity takes a while: the welcome's replay comes after the list's answers.
  const bound = Promise.withResolvers<void>();
  const f = harness(memory().storage, 32, {
    host: hostId,
    outbox: {
      load: async () => null,
      save: async () => {},
      hostBinding: { load: async () => null, save: () => bound.promise },
    },
  });
  const collection = f.client.threadsCollection();
  const store = collection.threads().store;
  await collection.threadsWindow({ archived: true });
  await f.start();
  f.elapse(250);
  await f.subscribed("threads");
  at(f, false, listOf([placed("a", "p", "inbox", 3)], 7));
  at(f, true, listOf([placed("old", "p", "settled", 1)], 7));
  const archive = windowWire(f, true);
  const home = windowWire(f, false);
  f.deliver({ type: "error", subscriptionId: home, code: "unavailable", message: "Busy" });
  await expect.poll(() => store.error?.code).toBe("daemon");
  bound.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The replay is no new socket: Home waits out its backoff, and the archive keeps its wire.
  expect(windowWire(f, false)).toBe(home);
  expect(windowWire(f, true)).toBe(archive);
  f.elapse(500);
  await expect.poll(() => windowWire(f, false)).not.toBe(home);
  expect(windowWire(f, true)).toBe(archive);
  collection.close();
  await f.client.close();
});
