import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { hostId, keyPair } from "@ace/secure-channel";
import type { KeyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import {
  CONTROL,
  Offer,
  Registration,
  address,
  deferred,
  initiate,
  json,
  peer,
} from "@ace/relay/testing";
import { PAIRED_MARKER } from "@ace/relay/wire";
import { WebSocket } from "ws";
import { mint, startWorker } from "./testing/harness.ts";

// Real hibernation: the harness evicts the relay object the way workerd does when its sockets
// go idle. Memory (routes, handshakes, frame budgets) is gone; sockets and their attachments
// stay. Every check below runs against the fresh instance that wakes for the next event.

let worker: Awaited<ReturnType<typeof startWorker>>;
const cleanups: (() => unknown)[] = [];
beforeAll(async () => {
  worker = await startWorker();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
afterAll(() => worker.close());

const hello = {
  type: "hello",
  protocolVersion: 1,
  deviceId: DeviceId.parse("phone"),
  token: "device token",
} as const;
const device = (account = "user_a") => [
  GRANT_SUBPROTOCOL_PREFIX + mint("device", account, "phone"),
];

async function daemon(limits: { maxClientChannels?: number } = {}) {
  const hostKeys = keyPair();
  let next = deferred<HostChannel>();
  const connection = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    limits,
    account: { grant: async () => mint("machine", "user_a", hostId(hostKeys.publicKey)) },
    onClientChannel: (channel) => next.resolve(channel),
  });
  cleanups.push(() => connection.close());
  const client = () =>
    connectClientViaRelay({
      relayUrl: worker.relayUrl,
      hostId: connection.hostId,
      pinnedFingerprint: connection.hostId,
      grant: mint("device", "user_a", "phone"),
    });
  async function connect() {
    next = deferred<HostChannel>();
    const opened = await client();
    cleanups.push(() => opened.close());
    const server = await next.promise;
    await opened.send(hello);
    expect(await server.receive()).toMatchObject({ type: "hello" });
    server.authorize();
    return { client: opened, server };
  }
  return { connection, connect, client };
}

/**
 * A raw relay socket that reports a close once the close frame arrives. workerd holds the TCP
 * connection of a closed hibernatable socket for about ten seconds; the daemon's own `dial`
 * stops waiting the same way.
 */
async function openPeer(url: string, protocols: string[] = []) {
  const options = { maxPayload: 65535, perMessageDeflate: false, closeTimeout: 500 };
  const socket = new WebSocket(url, protocols, options);
  const connection = peer(socket);
  const ending = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { ...connection, ending };
}

/** A daemon registered by hand, so the test decides when it joins a ticket. */
async function rawDaemon(keys: KeyPair = keyPair()) {
  const id = hostId(keys.publicKey);
  const control = await openPeer(address(worker.relayUrl, "/host", { hostId: id }), [
    GRANT_SUBPROTOCOL_PREFIX + mint("machine", "user_a", id),
  ]);
  cleanups.push(() => control.close());
  const transport = await initiate(control, CONTROL, keys);
  Registration.parse(json(transport.receive.decrypt(await control.next())));
  return {
    id,
    control,
    async offer() {
      return Offer.parse(json(transport.receive.decrypt(await control.next()))).ticket;
    },
  };
}

it("a daemon stays registered through hibernation: open streams keep flowing and new devices pair", async () => {
  const { connection, connect } = await daemon();
  const before = await connect();
  await worker.hibernate(connection.hostId);

  await before.client.send({ type: "ping" });
  expect(await before.server.receive()).toEqual({ type: "ping" });
  await before.server.send({ type: "pong" });
  expect(await before.client.receive()).toEqual({ type: "pong" });

  // The offer is sealed with the registration cipher restored from the attachment; a wrong
  // key or nonce would fail the daemon's decrypt and make it register again.
  const after = await connect();
  await after.client.send({ type: "ping" });
  expect(await after.server.receive()).toEqual({ type: "ping" });
  await worker.hibernate(connection.hostId);
  const third = await connect();
  await third.server.send({ type: "pong" });
  expect(await third.client.receive()).toEqual({ type: "pong" });
  expect(connection.generation).toBe(1);
});

it("after hibernation a daemon with every channel in use still turns a new device away as busy", async () => {
  const { connection, connect } = await daemon({ maxClientChannels: 1 });
  await connect();
  await worker.hibernate(connection.hostId);
  // The daemon's reject comes back under the restored receive cipher.
  const started = Date.now();
  const turned = await openPeer(
    address(worker.relayUrl, "/client", { hostId: connection.hostId }),
    device(),
  );
  cleanups.push(() => turned.close());
  expect(await turned.ending).toEqual({ code: 1013, reason: "Host busy" });
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(connection.generation).toBe(1);
});

it("a device waiting when the object hibernates is paired when the daemon joins", async () => {
  const host = await rawDaemon();
  const waiting = await openPeer(
    address(worker.relayUrl, "/client", { hostId: host.id }),
    device(),
  );
  cleanups.push(() => waiting.close());
  const ticket = await host.offer();
  await worker.hibernate(host.id);
  const joined = await openPeer(address(worker.relayUrl, "/join", { ticket, hostId: host.id }));
  cleanups.push(() => joined.close());
  expect([...(await waiting.next())]).toEqual([PAIRED_MARKER]);
  await waiting.send(new Uint8Array([1, 2, 3]));
  expect([...(await joined.next())]).toEqual([1, 2, 3]);
}, 15_000);

it("a device waiting when the object hibernates is closed when its ticket expires", async () => {
  const host = await rawDaemon();
  const waiting = await openPeer(
    address(worker.relayUrl, "/client", { hostId: host.id }),
    device(),
  );
  cleanups.push(() => waiting.close());
  await host.offer();
  await worker.hibernate(host.id);
  // The expiry alarm fires in the fresh instance, which finds the ticket in the attachment.
  expect(await waiting.ending).toEqual({ code: 1008, reason: "Ticket expired" });
  // The daemon's registration outlived both the eviction and the sweep.
  const next = await openPeer(address(worker.relayUrl, "/client", { hostId: host.id }), device());
  cleanups.push(() => next.close());
  await expect(host.offer()).resolves.toMatch(/^[a-f0-9]{64}$/);
}, 15_000);
