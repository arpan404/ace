import { afterEach, expect, it } from "vitest";
import { startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { Client, relayRoute } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import { DeviceId, MediaConnectResult } from "@ace/protocol";
import type { DaemonDelivery } from "./services/media.ts";
import { fixture } from "./socket-test-support.ts";

/*
 * `media.connect` across the real relay-to-main-session boundary (ADR 0147 §4): the daemon's
 * server behind the self-hosted relay on loopback, a paired phone's main session through the
 * relay, and one on the loopback listener. ace-media's side is a stand-in that grants with its
 * loopback address, as it does; the daemon decides who may be told it.
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** ace-media as the daemon's main sessions reach it: a grant naming its loopback listener. */
function delivery(): DaemonDelivery {
  const port = {
    sessionStarted() {},
    sessionEnded() {},
    sample() {},
    connect: async () => ({
      ok: true as const,
      connection: "mc_relaytest01",
      url: "ws://127.0.0.1:41999/media",
      ticket: "A".repeat(43),
      expiresAt: Date.now() + 30_000,
    }),
  };
  // Only the main session's part of the port is used on this path.
  return port as unknown as DaemonDelivery;
}

async function daemonBehindRelay() {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const media = delivery();
  const f = await fixture({
    relay: { url: relay.url, keys: keyPair() },
    mediaDelivery: () => media,
  });
  cleanup.push(() => f.close());
  const hostId = f.server.relayHostId;
  if (!hostId) throw new Error("Relay host missing");
  return { relay, f, hostId };
}

it("a main session through the relay is granted a media connection without the daemon's address", async () => {
  const { relay, f, hostId } = await daemonBehindRelay();
  const phone = f.store.devices.create("Phone", ["read", "operate"], Date.now());
  const route = relayRoute({
    relayUrl: relay.url,
    hostId,
    credential: async () => ({ token: phone.token }),
    socket: browserDeviceSocket,
    schedule: (callback, delayMs) => scheduler.set(delayMs, callback),
  });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse(phone.device.id),
    transport: route.transport,
    credential: route.credential,
    storage: { load: async () => null, save: async () => {} },
    scheduler,
    random: () => 0.5,
    id: () => `phone-${++sequence}`,
  });
  cleanup.push(() => client.close());
  await client.start();
  // Welcomed through the relay: the main session is open.
  for (let tries = 0; tries < 200 && client.state !== "ready"; tries++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  expect(client.state).toBe("ready");

  const reply = MediaConnectResult.parse(await client.request({ type: "media.connect" }));
  expect(reply.result).toMatchObject({ ok: true, connection: "mc_relaytest01" });
  expect(reply.result).not.toHaveProperty("url");
});

it("a main session on the loopback listener is told where ace-media listens", async () => {
  const { f } = await daemonBehindRelay();
  const local = await f.connect();
  expect(await local.next()).toMatchObject({ type: "welcome" });
  local.send({ type: "media.connect", requestId: "local-1" });
  let reply = await local.next();
  while (reply.type !== "media.connect.result") reply = await local.next();
  expect(reply.result).toMatchObject({ ok: true, url: "ws://127.0.0.1:41999/media" });
});
