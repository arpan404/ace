import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import { Client, type ClientOptions, type Lease, type ThreadSource } from "@ace/client";
import { FakeDaemon, facts, fakeTransport } from "@ace/fake-daemon";
import type { HostRequest } from "@ace/native-host";
import { DeviceId, ThreadId } from "@ace/protocol";
import { handleCacheAction, type CacheAction } from "./chat-cache.ts";
import { nativeReadSnapshots } from "./read-snapshots.ts";
import { RecordingSink, until } from "./sheet-fixture.ts";
import { nativeStore } from "./snapshot-store-fixture.ts";

/*
 * Clearing the chats this phone keeps, and reloading one thread from its machine (ADR 0105):
 * only cached reads go. What was cleared is read from the machine next time, and an unsent
 * message in the outbox still reaches it.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

const offline: ClientOptions["transport"] = () => ({ open() {}, send() {}, close() {} });

function machine() {
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  for (const id of ["one", "two"]) {
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
      facts.message("root", "ask", "user", `Question ${id}`),
      facts.message("root", "answer", "assistant", `Answer ${id}`),
      facts.endTurn("root"),
    ]);
  }
  return daemon;
}

/** One launch of the phone's runtime for `daemon`, over `call`'s snapshot store and `outbox`. */
function phone(
  daemon: FakeDaemon,
  call: HostRequest,
  outbox: Map<string, string>,
  transport: ClientOptions["transport"],
) {
  let ids = 0;
  const snapshots = nativeReadSnapshots(call, () => 1_000);
  const client = new Client({
    deviceId: DeviceId.parse("ios-cache-device"),
    expectedHostId: daemon.hostId,
    transport,
    credential: async () => daemon.token,
    storage: {
      load: async () => null,
      save: async () => {},
      records: {
        load: async () => [...outbox.values()],
        write: async (id, value) => {
          if (value === null) outbox.delete(id);
          else outbox.set(id, value);
        },
      },
    },
    readSnapshots: snapshots,
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
  return { client, snapshots };
}

/** Open `id`, wait until it shows its two items, and close the launch so its rows are written. */
async function readOnce(daemon: FakeDaemon, call: HostRequest, ids: readonly string[]) {
  const { client } = phone(daemon, call, new Map(), () => fakeTransport(daemon));
  await client.start();
  for (const id of ids) {
    const lease = client.thread(id);
    await until(() => lease.store.order.length === 2, `${id} loaded`);
    lease.release();
  }
  await client.close();
}

/** Whether an offline launch paints `id` from what the phone keeps. */
async function paintsFromCache(daemon: FakeDaemon, call: HostRequest, id: string) {
  const { client } = phone(daemon, call, new Map(), offline);
  await client.start();
  const lease = client.thread(id);
  closers.push(() => lease.release());
  // The kept copy, if any, is read straight from the store: give it a few turns to land.
  for (let turn = 0; turn < 20 && lease.store.order.length === 0; turn++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  return lease.store.order.length > 0;
}

function act(
  action: CacheAction,
  client: Client,
  snapshots: ReturnType<typeof nativeReadSnapshots>,
  sink: RecordingSink,
  open?: { threadId: string; lease: Lease<ThreadSource> | undefined; reopened?: ThreadSource },
) {
  return handleCacheAction(action, {
    client,
    snapshots,
    sink,
    openThread: () => open?.threadId,
    leave() {
      open?.lease?.release();
      if (open) open.lease = undefined;
    },
    reopen(threadId) {
      const lease = client.thread(threadId);
      closers.push(() => lease.release());
      if (open) open.reopened = lease.store;
    },
  });
}

test("clearing cached chats leaves nothing to paint offline, and an unsent message still reaches the machine", async () => {
  const daemon = machine();
  const { call } = nativeStore();
  await readOnce(daemon, call, ["one", "two"]);

  // Offline, the person sends a message: it waits in the outbox.
  const outbox = new Map<string, string>();
  const away = phone(daemon, call, outbox, offline);
  await away.client.start();
  void away.client
    .command({
      type: "thread.send",
      threadId: ThreadId.parse("one"),
      input: [{ type: "text", text: "Still there?" }],
    })
    .catch(() => {});
  await until(() => outbox.size === 1, "send admitted");

  const sink = new RecordingSink();
  await act({ type: "cache.clear" }, away.client, away.snapshots, sink);
  expect(sink.read("cache.usage")).toMatchObject({ type: "cache.usage", threads: 0 });
  expect(outbox.size).toBe(1);
  await away.client.close();

  expect(await paintsFromCache(daemon, call, "one")).toBe(false);

  // Back online: the thread comes from the machine, and the unsent message is delivered.
  const back = phone(daemon, call, outbox, () => fakeTransport(daemon));
  await back.client.start();
  const lease = back.client.thread("one");
  closers.push(() => lease.release());
  await until(
    () => lease.store.unconfirmed === false && lease.store.order.length >= 2,
    "read from the machine",
  );
  await until(() => outbox.size === 0, "outbox delivered");
});

test("reloading one thread drops only its cached copy", async () => {
  const daemon = machine();
  const { call } = nativeStore();
  await readOnce(daemon, call, ["one", "two"]);

  const { client, snapshots } = phone(daemon, call, new Map(), offline);
  await client.start();
  const sink = new RecordingSink();
  await act({ type: "cache.reload", threadId: "one" }, client, snapshots, sink);
  expect(sink.read("cache.usage")).toMatchObject({ threads: 1 });
  await client.close();

  expect(await paintsFromCache(daemon, call, "one")).toBe(false);
  expect(await paintsFromCache(daemon, call, "two")).toBe(true);
});

test("reloading the open thread shows a fresh copy read from the machine, not the one held", async () => {
  const daemon = machine();
  const { call } = nativeStore();
  const { client, snapshots } = phone(daemon, call, new Map(), () => fakeTransport(daemon));
  await client.start();
  const first = client.thread("one");
  await until(() => first.store.order.length === 2, "loaded");
  // The machine moved on; the phone still holds what it read.
  daemon.apply("one", [facts.message("root", "later", "user", "One more thing")]);

  const open: {
    threadId: string;
    lease: Lease<ThreadSource> | undefined;
    reopened?: ThreadSource;
  } = { threadId: "one", lease: first };
  await act(
    { type: "cache.reload", threadId: "one" },
    client,
    snapshots,
    new RecordingSink(),
    open,
  );
  const reopened = open.reopened;
  expect(reopened).toBeDefined();
  expect(reopened).not.toBe(first.store);
  await until(() => reopened?.unconfirmed === false && reopened.order.length === 3, "read again");
});
