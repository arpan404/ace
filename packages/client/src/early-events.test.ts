import { ClientCore, defaultLimits, type TransportEvents } from "./index.ts";
import { ClientMessage, DeviceId, ThreadView } from "@ace/protocol";
import { expect, test } from "vitest";

// Events an NK relay session gets before it confirms (ADR 0155, `events.early`): applied ahead
// of the subscription, they mark nothing current, and the subscription that follows may still
// answer with a snapshot, which the client takes.

const view = (seq: number, title = "Thread") =>
  ThreadView.parse({
    kind: "thread",
    seq,
    thread: {
      id: "thread",
      workspaceId: "workspace",
      provider: "codex",
      title,
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

const titled = (seq: number, title: string) => ({
  seq,
  id: `event-${seq}`,
  threadId: "thread",
  at: seq,
  payload: { type: "thread.updated", title },
});

async function resumed() {
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
  const first = lastSubscribe();
  deliver({ type: "snapshot", subscriptionId: first.subscriptionId, seq: 1, view: view(1) });
  deliver({ type: "subscription.ready", subscriptionId: first.subscriptionId, seq: 1 });
  const before = timers.length;
  socket?.close(1006);
  for (const timer of timers.slice(before)) if (timer.live) timer.run();
  deliver({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 3 });
  const again = lastSubscribe();
  return { lease, deliver, subscriptionId: again.subscriptionId };
}

test("early events are applied, and the thread stays syncing and unconfirmed until the subscription is ready", async () => {
  const h = await resumed();
  h.deliver({
    type: "events",
    subscriptionId: h.subscriptionId,
    afterSeq: 1,
    throughSeq: 2,
    events: [titled(2, "Early")],
    early: true,
  });
  expect(h.lease.store.thread?.title).toBe("Early");
  expect(h.lease.store.syncing).toBe(true);
  // The subscription made at confirmation catches up from the early cursor, then says ready.
  h.deliver({
    type: "events",
    subscriptionId: h.subscriptionId,
    afterSeq: 2,
    throughSeq: 3,
    events: [titled(3, "Current")],
  });
  h.deliver({ type: "subscription.ready", subscriptionId: h.subscriptionId, seq: 3 });
  expect(h.lease.store.thread?.title).toBe("Current");
  expect(h.lease.store.syncing).toBe(false);
  expect(h.lease.store.unconfirmed).toBe(false);
});

test("after early events the subscription may answer with a snapshot, and the client takes it", async () => {
  const h = await resumed();
  h.deliver({
    type: "events",
    subscriptionId: h.subscriptionId,
    afterSeq: 1,
    throughSeq: 2,
    events: [titled(2, "Early")],
    early: true,
  });
  h.deliver({
    type: "snapshot",
    subscriptionId: h.subscriptionId,
    seq: 9,
    view: view(9, "Snapshot"),
  });
  expect(h.lease.store.thread?.title).toBe("Snapshot");
  expect(h.lease.store.cursor).toBe(9);
  expect(h.lease.store.syncing).toBe(false);
});
