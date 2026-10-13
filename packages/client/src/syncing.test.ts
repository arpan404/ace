import { ClientCore, defaultLimits, type TransportEvents } from "./index.ts";
import { ClientMessage, DeviceId, ThreadView } from "@ace/protocol";
import { expect, test } from "vitest";

const view = ThreadView.parse({
  kind: "thread",
  seq: 1,
  thread: {
    id: "thread",
    workspaceId: "workspace",
    provider: "codex",
    title: "Thread",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  },
  agents: {},
  runs: {},
  items: {},
  itemOrder: [],
  interactions: {},
  backgroundTasks: {},
  usage: {},
  usageSnapshots: {},
  agentChildren: {},
});

test("a thread on screen reads as syncing from a dropped connection until its replay lands", async () => {
  let socket: TransportEvents | undefined;
  const sent: unknown[] = [];
  const timers: { run(): void; live: boolean }[] = [];
  let id = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("device"),
    transport: () => ({
      open(events) {
        socket = events;
      },
      send(text) {
        sent.push(JSON.parse(text));
      },
      close() {},
    }),
    credential: async () => "a".repeat(64),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(_delayMs, run) {
        const timer = { run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    },
    random: () => 0.5,
    id: () => `id-${++id}`,
    limits: defaultLimits,
  });
  await client.start();
  const deliver = (message: unknown) => socket?.message(JSON.stringify(message));
  const lastSubscribe = () => {
    const request = ClientMessage.parse(sent.at(-1));
    if (request.type !== "subscribe") throw new Error("Missing subscribe");
    return request;
  };
  deliver({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 1 });
  const lease = client.thread("thread");
  const heard: boolean[] = [];
  const syncing = lease.store.select(["sync"], (reader) => reader.syncing ?? false);
  const stop = syncing.subscribe(() => heard.push(syncing.getSnapshot()));

  // The first open is loading, not catching up.
  const first = lastSubscribe();
  expect(lease.store.syncing).toBe(false);
  deliver({ type: "snapshot", subscriptionId: first.subscriptionId, seq: 1, view });
  deliver({ type: "subscription.ready", subscriptionId: first.subscriptionId, seq: 1 });
  expect(lease.store.syncing).toBe(false);

  // The connection drops: what the view shows is now behind.
  const before = timers.length;
  socket?.close(1006);
  expect(lease.store.syncing).toBe(true);

  // Back: the subscription resumes after what it holds and stays syncing until the replay ends.
  for (const timer of timers.slice(before)) if (timer.live) timer.run();
  deliver({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 1 });
  const resumed = lastSubscribe();
  expect(resumed.afterSeq).toBe(1);
  expect(lease.store.syncing).toBe(true);
  deliver({ type: "subscription.ready", subscriptionId: resumed.subscriptionId, seq: 1 });
  expect(lease.store.syncing).toBe(false);
  expect(heard).toEqual([true, false]);
  stop();
  lease.release();
});
