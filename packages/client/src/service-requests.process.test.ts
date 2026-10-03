import { afterEach, expect, test } from "vitest";
import { setup, ready, memoryStorage, when } from "./test-support.ts";
import { ClientMessage } from "@ace/protocol";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("service reads correlate concurrent replies without storing commands or touching the outbox", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const storage = memoryStorage();
  const { client, faults } = f.make({ storage });
  await ready(client);
  const before = await storage.load();
  const [settings, models, accounts, usage, search, commands] = await Promise.all([
    client.request({ type: "settings.get", key: "threads.autoSettleAfter", scope: {} }),
    client.request({ type: "models.list" }),
    client.request({ type: "accounts.list" }),
    client.request({ type: "usage.summary", query: { from: "2026-10-01", to: "2026-10-02" } }),
    client.request({ type: "search.status" }),
    client.request({ type: "commands.list", threadId: f.thread.id }),
  ]);
  expect(settings.entries).toContainEqual({
    key: "threads.autoSettleAfter",
    value: "1d",
    provenance: "defaults",
  });
  expect(models.type).toBe("models.result");
  expect(accounts.type).toBe("accounts.list");
  expect(usage.kind).toBe("summary");
  expect(search.type).toBe("search.progress");
  expect(commands.commands.length).toBeGreaterThan(0);
  expect(await storage.load()).toBe(before);
  expect(
    f.daemon.store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()?.n,
    ),
  ).toBe(0);
  expect(
    faults.sent
      .map((frame) => ClientMessage.parse(JSON.parse(frame)))
      .some((message) => message.type === "command"),
  ).toBe(false);
});

test("legacy health command callers receive health without creating a durable intent", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client } = f.make();
  await ready(client);
  expect(await client.command({ type: "diagnostics.health" }, {}, "health-read")).toMatchObject({
    commandId: "health-read",
    ok: true,
    health: { logs: { failed: 0 } },
  });
  expect(client.intent("health-read").getSnapshot()).toBeUndefined();
  expect(
    f.daemon.store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()?.n,
    ),
  ).toBe(0);
});

test("disconnect rejects one-off requests and reconnect never replays them", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client, faults, scheduler } = f.make();
  await ready(client);
  faults.incoming = (message, frame, deliver) => {
    if (message.type !== "settings.result") deliver(frame);
  };
  const read = client.request({ type: "settings.get", key: "providers.default", scope: {} });
  const rejected = expect(read).rejects.toMatchObject({ code: "offline" });
  await faults.wait((message) => message.type === "settings.result");
  faults.disconnect();
  await rejected;
  const count = () =>
    faults.sent.filter((frame) => ClientMessage.parse(JSON.parse(frame)).type === "settings.get")
      .length;
  expect(count()).toBe(1);
  scheduler.advance(1000);
  await when(client.connectionState(), (value) => value === "ready");
  expect(count()).toBe(1);
});

test("cancellation releases request capacity and does not cancel a different correlation", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client, faults } = f.make({ limits: { requests: 1 } });
  await ready(client);
  faults.incoming = (message, frame, deliver) => {
    if (message.type !== "settings.result") deliver(frame);
  };
  const controller = new AbortController();
  const read = client.request(
    { type: "settings.get", key: "providers.default", scope: {} },
    { signal: controller.signal },
  );
  const rejected = expect(read).rejects.toMatchObject({ code: "aborted" });
  await faults.wait((message) => message.type === "settings.result");
  await expect(client.request({ type: "accounts.list" })).rejects.toMatchObject({ code: "limit" });
  controller.abort();
  await rejected;
  expect((await client.request({ type: "accounts.list" })).type).toBe("accounts.list");
});

test("settings subscriptions release explicitly and later settings writes produce no stale update", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client } = f.make();
  await ready(client);
  const changes: unknown[] = [];
  const stop = client.onMessage((message) => {
    if (message.type === "settings.changed") changes.push(message);
  });
  try {
    await client.request({
      type: "settings.subscribe",
      subscriptionId: "preferences",
      scope: {},
      keys: ["threads.autoSettleAfter"],
    });
    await client.request({
      type: "settings.set",
      key: "threads.autoSettleAfter",
      value: "never",
      layer: { kind: "global" },
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        subscriptionId: "preferences",
        entries: [{ key: "threads.autoSettleAfter", value: "never", provenance: "global" }],
      }),
    );
    await client.request({ type: "settings.unsubscribe", subscriptionId: "preferences" });
    changes.length = 0;
    await client.request({
      type: "settings.set",
      key: "threads.autoSettleAfter",
      value: "2d",
      layer: { kind: "global" },
    });
    expect(changes).toEqual([]);
  } finally {
    stop();
  }
});

test("a denied service write rejects that request while a read-only device stays connected", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const device = f.daemon.store.devices.create("Reader", ["read"], 1);
  const { client } = f.make({ deviceId: device.device.id, credential: async () => device.token });
  await ready(client);
  await expect(
    client.request({
      type: "settings.set",
      key: "threads.autoSettleAfter",
      value: "never",
      layer: { kind: "global" },
    }),
  ).rejects.toMatchObject({ code: "daemon" });
  expect((await client.request({ type: "diagnostics.health" })).ok).toBe(true);
  expect(client.state).toBe("ready");
});
