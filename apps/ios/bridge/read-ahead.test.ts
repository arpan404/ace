import { afterEach, expect, test } from "vitest";
import { Client, type SidebarReader } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, ThreadListEntry } from "@ace/protocol";
import { ReadAhead, readAheadPicks } from "./read-ahead.ts";
import { until } from "./sheet-fixture.ts";

/*
 * Reading ahead the threads the person is likely to open (ADR 0128): which ones, and that each is
 * read once through a spare slot and let go, only while native allows it.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

const day = 24 * 60 * 60 * 1000;
const now = 30 * day;

function entry(id: string, updatedAt: number, extra: Record<string, unknown> = {}) {
  return ThreadListEntry.parse({
    id,
    workspaceId: "ace",
    provider: "codex",
    title: id,
    status: { state: "done" },
    createdAt: 0,
    updatedAt,
    ...extra,
  });
}
const settled = { settledAt: 1, status: { state: "done" } };
const working = { status: { state: "working", agents: 1 } };

function list(entries: ThreadListEntry[], state: Partial<SidebarReader> = {}): SidebarReader {
  const byId = new Map<string, ThreadListEntry>(entries.map((value) => [value.id, value]));
  return {
    loaded: true,
    error: undefined,
    ids: entries.map((value) => value.id),
    thread: (id) => byId.get(id),
    ...state,
  };
}

test.each([
  {
    name: "unsettled threads come before settled ones, each newest first",
    entries: [
      entry("old-done", now - 3 * day, settled),
      entry("new-done", now - day, settled),
      entry("busy", now - 2 * day, working),
      entry("unread", now - 4 * day),
    ],
    picks: ["busy", "unread", "new-done", "old-done"],
  },
  {
    name: "at most the limit, the likeliest kept",
    entries: Array.from({ length: 6 }, (_, index) => entry(`t${index}`, now - index * 1000)),
    picks: ["t0", "t1", "t2", "t3"],
  },
  {
    name: "archived, deleted, hidden and week-old threads are left alone",
    entries: [
      entry("archived", now, { archivedAt: now }),
      entry("deleted", now, { deletedAt: now }),
      entry("stale", now - 8 * day),
      entry("kept", now - day),
    ],
    picks: ["kept"],
  },
])("read-ahead picks: $name", ({ entries, picks }) => {
  expect(readAheadPicks(list(entries), () => false, now)).toEqual(picks);
});

test.each([
  { name: "not loaded yet", state: { loaded: false } },
  { name: "still syncing", state: { syncing: true } },
  { name: "read back from disk, unconfirmed", state: { unconfirmed: true } },
])("nothing is read ahead from a list $name", ({ state }) => {
  expect(readAheadPicks(list([entry("busy", now, working)], state), () => false, now)).toEqual([]);
});

const openOrHeld = (id: string) => id === "open" || id === "held";

test("threads the caller skips are passed over for the next likeliest", () => {
  const entries = [entry("open", now), entry("held", now - 1), entry("next", now - 2)];
  expect(readAheadPicks(list(entries), openOrHeld, now)).toEqual(["next"]);
});

/** A machine with `ids` threads, each asked and answered once. */
function machine(ids: readonly string[]) {
  const daemon = new FakeDaemon({ clock: () => now });
  for (const id of ids) {
    daemon.createThread({
      id,
      workspaceId: "ace",
      title: id,
      provider: "codex",
      hasSentMessage: true,
    });
    daemon.apply(id, [
      facts.rootAgent("codex"),
      facts.turn("root"),
      facts.message("root", `ask-${id}`, "user", `Question ${id}`),
      facts.message("root", `answer-${id}`, "assistant", `Answer ${id}`),
      facts.endTurn("root"),
    ]);
  }
  return daemon;
}

async function phone(daemon: FakeDaemon, open?: string) {
  let ids = 0;
  /** While set, thread subscriptions never reach the daemon: a read stays under way. */
  const network = { silent: false };
  const client = new Client({
    deviceId: DeviceId.parse("ios-read-ahead"),
    expectedHostId: daemon.hostId,
    transport: () => {
      const inner = fakeTransport(daemon);
      return {
        ...inner,
        send(text: string) {
          if (
            network.silent &&
            text.includes('"type":"subscribe"') &&
            text.includes('"kind":"thread"')
          )
            return;
          inner.send(text);
        },
      };
    },
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
  });
  closers.push(() => client.close());
  await client.start();
  const sidebar = client.threads();
  closers.push(() => sidebar.release());
  await until(() => sidebar.store.loaded && !sidebar.store.syncing, "inbox loaded");
  const leases: string[] = [];
  const hooks: { leased?: (id: string) => void } = {};
  const ahead = new ReadAhead({
    list: () => client.cachedThreads(),
    observeList: (listener) => sidebar.store.observe(listener),
    lease: (id) => {
      leases.push(id);
      const lease = client.thread(id, { optional: true });
      hooks.leased?.(id);
      return lease;
    },
    held: (id) => client.cachedThread(id) !== undefined,
    open: () => open,
    // Time runs a hundred times faster: the settle wait is 15 ms, a read's patience 150 ms.
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs / 100);
      return () => clearTimeout(timer);
    },
    now: () => now,
  });
  closers.push(() => ahead.stop());
  const room = client.threadRoom();
  return { client, ahead, leases, hooks, network, room: () => room.getSnapshot() };
}

test("once allowed, the likeliest threads are read ahead, confirmed and let go", async () => {
  const daemon = machine(["one", "two", "three"]);
  const { client, ahead, leases, room } = await phone(daemon, "three");
  const spare = room();
  ahead.start();
  ahead.allow(true);
  await until(
    () => ["one", "two"].every((id) => client.cachedThread(id)?.unconfirmed === true),
    "read and let go",
  );
  // The pass is over: nothing else comes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(leases.toSorted()).toEqual(["one", "two"]);
  // Each read ahead keeps its messages for the open that may follow, and holds no slot.
  expect(client.cachedThread("one")?.order).toHaveLength(2);
  expect(room()).toBe(spare);
  // The thread already open is never read ahead.
  expect(client.cachedThread("three")).toBeUndefined();
});

test("nothing is read ahead until native allows it, and a pass stops when it no longer does", async () => {
  const daemon = machine(["one", "two", "three"]);
  const { ahead, leases, network, room } = await phone(daemon);
  const spare = room();
  ahead.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(leases).toEqual([]);
  // The machine is slow to answer: the first read stays under way, holding a slot.
  network.silent = true;
  ahead.allow(true);
  await until(() => leases.length === 1 && room() < spare, "a read under way");
  // Native says no (the phone left Wi-Fi): the read is let go at once, and no other starts.
  ahead.allow(false);
  expect(room()).toBe(spare);
  network.silent = false;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(leases).toHaveLength(1);
});

test("a thread read ahead once is not read again until it changes", async () => {
  const daemon = machine(["one"]);
  const { client, ahead, leases } = await phone(daemon);
  ahead.start();
  ahead.allow(true);
  await until(() => client.cachedThread("one") !== undefined, "read ahead");
  await client.forgetThread("one");
  // Another inbox change: the thread is as it was read, so it is not read again.
  ahead.allow(false);
  ahead.allow(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(leases).toEqual(["one"]);
});
