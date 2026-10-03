import { Client } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { SoakDaemon, fakeTransport } from "./index.ts";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

test("a client following the endless agent sees fresh exchanges in a bounded window", async () => {
  let now = 1;
  let ids = 0;
  const daemon = new SoakDaemon({ clock: () => (now += 1) });
  const client = new Client({
    deviceId: DeviceId.parse("soak-device"),
    transport: () => fakeTransport(daemon),
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
  clients.push(client);
  await client.start();
  const lease = client.thread(daemon.threadId);
  await vi.waitFor(() => expect(lease.store.thread?.title).toBe("Soak: relay replay under load"));
  for (let round = 0; round < 40; round++) {
    daemon.pump(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await vi.waitFor(() => expect(lease.store.cursor).toBe(daemon.head));
  expect(client.state).toBe("ready");
  expect(lease.store.error).toBeUndefined();
  expect(lease.store.order.length).toBeLessThanOrEqual(200);
  const last = lease.store.item(lease.store.order.at(-1) ?? "");
  expect(last?.type).toBe("tool_call");
  const answers = lease.store.order
    .map((id) => lease.store.item(id))
    .filter((item) => item?.type === "message" && item.role === "assistant");
  expect(answers.length).toBeGreaterThan(10);
  lease.release();
});

test("a thread with more turns than the client's entity limit keeps streaming", async () => {
  let now = 1;
  let ids = 0;
  const daemon = new SoakDaemon({ clock: () => (now += 1), deltas: 2 });
  const client = new Client({
    deviceId: DeviceId.parse("turns-device"),
    transport: () => fakeTransport(daemon),
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
    // The 200-item window spans ~70 turns here; the limit sits just above that.
    limits: { entities: 100 },
  });
  clients.push(client);
  await client.start();
  const lease = client.thread(daemon.threadId);
  await vi.waitFor(() => expect(lease.store.thread).toBeDefined());
  // ~1,500 turns, each with its own run.
  for (let round = 0; round < 30; round++) {
    daemon.pump(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lease.store.error?.message).toBeUndefined();
  await vi.waitFor(() => expect(lease.store.cursor).toBe(daemon.head));
  const newest = lease.store.item(lease.store.order.at(-1) ?? "");
  expect(newest?.runId && lease.store.run(newest.runId)).toBeTruthy();
  lease.release();
});

test("a thread with more approvals and background tasks than the client's entity limit keeps streaming", async () => {
  let now = 1;
  let ids = 0;
  const daemon = new SoakDaemon({ clock: () => (now += 1), deltas: 2, interactive: true });
  const client = new Client({
    deviceId: DeviceId.parse("approvals-device"),
    transport: () => fakeTransport(daemon),
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
    // The 200-item window spans ~50 turns here; the limit sits just above that.
    limits: { entities: 80 },
  });
  clients.push(client);
  await client.start();
  const lease = client.thread(daemon.threadId);
  await vi.waitFor(() => expect(lease.store.thread).toBeDefined());
  // ~600 turns, each with its own approval and background task.
  for (let round = 0; round < 30; round++) {
    daemon.pump(500);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lease.store.error?.message).toBeUndefined();
  await vi.waitFor(() => expect(lease.store.cursor).toBe(daemon.head));
  expect(lease.store.interactionIds().length).toBeLessThanOrEqual(80);
  // Every approval a loaded step belongs to is still there to show.
  for (const id of lease.store.order) {
    const item = lease.store.item(id);
    if (item?.type !== "tool_call" || !item.call.backgroundTaskId) continue;
    expect(lease.store.task(item.call.backgroundTaskId)).toBeDefined();
  }
  lease.release();
});
