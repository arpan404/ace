import { ClientMessage, DeviceId, ThreadView } from "@ace/protocol";
import { expect, test } from "vitest";
import { ClientCore, defaultLimits, type TransportEvents } from "./index.ts";

/** A connected client on manual time, with the subscribes it sent. */
async function harness() {
  let socket: TransportEvents | undefined;
  const sent: ClientMessage[] = [];
  const timers = new Set<{ at: number; run(): void }>();
  let now = 0;
  let id = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("device"),
    transport: () => ({
      open(events) {
        socket = events;
      },
      send(text) {
        for (const line of text.split("\n")) sent.push(ClientMessage.parse(JSON.parse(line)));
      },
      close() {},
    }),
    credential: async () => "a".repeat(64),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delay, run) {
        const timer = { at: now + delay, run };
        timers.add(timer);
        return () => void timers.delete(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++id}`,
    now: () => now,
    monotonic: () => now,
    limits: defaultLimits,
  });
  await client.start();
  const deliver = (message: unknown) => socket?.message(JSON.stringify(message));
  deliver({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 1 });
  const subscribes = () => sent.filter((message) => message.type === "subscribe");
  const lastSubscription = () => {
    const last = subscribes().at(-1);
    if (!last) throw new Error("No subscribe");
    return last.subscriptionId;
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      now = next.at;
      next.run();
    }
    now = until;
  };
  return { client, deliver, subscribes, lastSubscription, advance };
}

const view = ThreadView.parse({
  kind: "thread",
  seq: 3,
  thread: {
    id: "child",
    workspaceId: "workspace",
    provider: "codex",
    title: "Delegated child",
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

test("an open thread the daemon refused loads by itself once the daemon serves it", async () => {
  const app = await harness();
  const held = app.client.thread("child");
  app.deliver({
    type: "error",
    subscriptionId: app.lastSubscription(),
    code: "subscribe_failed",
    message: "Unknown thread or invalid cursor",
  });
  expect(held.store.error?.message).toBe("subscribe_failed");

  // Refused again: the next try waits longer, and the error stays until one lands.
  app.advance(500);
  expect(app.subscribes()).toHaveLength(2);
  app.deliver({
    type: "error",
    subscriptionId: app.lastSubscription(),
    code: "subscribe_failed",
    message: "Unknown thread",
  });
  app.advance(500);
  expect(app.subscribes()).toHaveLength(2);
  app.advance(500);
  expect(app.subscribes()).toHaveLength(3);

  const current = app.lastSubscription();
  app.deliver({ type: "snapshot", subscriptionId: current, seq: 3, view });
  app.deliver({ type: "subscription.ready", subscriptionId: current, seq: 3 });
  expect(held.store.error).toBeUndefined();
  expect(held.store.thread?.title).toBe("Delegated child");
  held.release();
  await app.client.close();
});

test("a refused thread nobody holds any more is not asked for again", async () => {
  const app = await harness();
  const held = app.client.thread("child");
  app.deliver({
    type: "error",
    subscriptionId: app.lastSubscription(),
    code: "subscribe_failed",
    message: "Unknown thread",
  });
  held.release();
  app.advance(60_000);
  expect(app.subscribes()).toHaveLength(1);
  await app.client.close();
});
