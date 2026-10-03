import { afterEach, expect, test } from "vitest";
import type { ServerMessage } from "@ace/protocol";
import { ready, setup } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("a setting written through a service request is read back and pushed to subscribers", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make();
  await ready(client);
  const changes: ServerMessage[] = [];
  const release = client.onMessage((message) => {
    if (message.type === "settings.changed") changes.push(message);
  });
  const subscribed = await client.request({
    type: "settings.subscribe",
    subscriptionId: "sound",
    keys: ["notifications.sound"],
    scope: {},
  });
  expect(subscribed.ok).toBe(true);

  const written = await client.request({
    type: "settings.set",
    key: "notifications.sound",
    value: false,
    layer: { kind: "global" },
  });
  expect(written.ok).toBe(true);

  const read = await client.request({
    type: "settings.get",
    key: "notifications.sound",
    scope: {},
  });
  expect(read.entries).toContainEqual({
    key: "notifications.sound",
    value: false,
    provenance: "global",
  });
  await expect.poll(() => changes.length).toBeGreaterThan(0);
  release();
});

test("an invalid request is refused before it reaches the daemon", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  const sent = faults.sent.length;
  await expect(
    client.request({ type: "search.query", text: "x".repeat(600) }),
  ).rejects.toMatchObject({ code: "protocol" });
  expect(faults.sent).toHaveLength(sent);
});

test("a request made while offline rejects instead of waiting for a connection", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make();
  await expect(client.request({ type: "models.list" })).rejects.toMatchObject({ code: "offline" });
});
