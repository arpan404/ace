import { expect, test } from "vitest";
import { harness, memory, thread } from "./read-snapshots.fixture.ts";

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
