import { readFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { ClientError, ticketCredential } from "./index.ts";
import { setup, ready, when, barrier } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("a device token exchanges for a fresh socket ticket on reconnect", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const device = h.daemon.store.devices.create("SDK device", ["read", "operate"], 1);
  const credential = ticketCredential(
    async () => device.token,
    async (token) => {
      const result = await fetch(h.daemon.url.replace("ws:", "http:") + "/v1/tickets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!result.ok) throw new ClientError("auth");
      return result.json();
    },
  );
  const { client, faults, scheduler } = h.make({ deviceId: device.device.id, credential });
  await ready(client);
  await barrier(client, h.thread.id);
  faults.disconnect();
  scheduler.advance(125);
  await when(client.connectionState(), (state) => state === "ready");
  await barrier(client, h.thread.id);
  const hellos = faults.sent
    .map((frame) => JSON.parse(frame))
    .filter((frame) => frame.type === "hello");
  expect(hellos).toHaveLength(2);
  expect(hellos[0]?.ticket).not.toBe(hellos[1]?.ticket);
  expect(hellos[0]?.token).toBeUndefined();
  expect(hellos[1]?.token).toBeUndefined();
});

test("new read requests enforce the paired device read scope", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const device = h.daemon.store.devices.create("Operate only", ["operate"], 1);
  const credential = ticketCredential(
    async () => device.token,
    async (token) => {
      const result = await fetch(h.daemon.url.replace("ws:", "http:") + "/v1/tickets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      return result.json();
    },
  );
  const { client } = h.make({ deviceId: device.device.id, credential });
  await ready(client);
  await expect(client.itemsPage({ threadId: h.thread.id, limit: 1 })).rejects.toMatchObject({
    code: "daemon",
    message: "forbidden",
  });
  expect(client.state).toBe("ready");
});

test("revoking a paired device stops the SDK rather than reconnecting forever", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const device = h.daemon.store.devices.create("Revocable", ["read"], 1);
  const credential = ticketCredential(
    async () => device.token,
    async (token) => {
      const result = await fetch(h.daemon.url.replace("ws:", "http:") + "/v1/tickets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!result.ok) throw new ClientError("auth");
      return result.json();
    },
  );
  const { client, scheduler } = h.make({ deviceId: device.device.id, credential });
  await ready(client);
  const token = (await readFile(h.daemon.tokenPath, "utf8")).trim();
  const response = await fetch(
    h.daemon.url.replace("ws:", "http:") + `/v1/devices/${device.device.id}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  expect(response.ok).toBe(true);
  await when(client.connectionState(), (state) => state === "fatal" || state === "reconnecting");
  if (client.state === "reconnecting") scheduler.advance(125);
  await when(client.connectionState(), (state) => state === "fatal");
  scheduler.advance(100000);
  expect(client.state).toBe("fatal");
  expect(client.error?.code).toBe("auth");
});
