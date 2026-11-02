import { afterAll, beforeAll, afterEach, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import type { TestHarness } from "wrangler";
import { DeviceId } from "@ace/protocol";
import { hostId, keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { address, CONTROL, deferred, initiate, openPeer } from "@ace/relay/testing";

let harness: TestHarness;
let relayUrl: string;
const cleanups: (() => unknown)[] = [];
beforeAll(async () => {
  harness = createTestHarness({
    workers: [{ configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)) }],
  });
  const { url } = await harness.listen();
  relayUrl = url.toString().replace(/^http/, "ws");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
afterAll(() => harness.close());

async function host(limits: Parameters<typeof connectHostToRelay>[0]["limits"] = {}) {
  const hostKeys = keyPair();
  let next = deferred<HostChannel>();
  const connection = await connectHostToRelay({
    relayUrl,
    hostKeys,
    limits,
    onClientChannel: (channel) => next.resolve(channel),
  });
  cleanups.push(() => connection.close());
  async function connect() {
    next = deferred<HostChannel>();
    const client = await connectClientViaRelay({
      relayUrl,
      hostId: connection.hostId,
      pinnedFingerprint: connection.hostId,
    });
    cleanups.push(() => client.close());
    const server = await next.promise;
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("phone"),
      token: "device token",
    });
    expect(await server.receive()).toMatchObject({ type: "hello", token: "device token" });
    server.authorize();
    return { client, server };
  }
  return { connection, hostKeys, connect };
}

it("a daemon and a pinned client exchange encrypted messages through the Worker in both directions", async () => {
  const { connect } = await host();
  const first = await connect();
  const second = await connect();
  await first.client.send({ type: "ping" });
  expect(await first.server.receive()).toEqual({ type: "ping" });
  await second.server.send({ type: "pong" });
  expect(await second.client.receive()).toEqual({ type: "pong" });
  first.client.close();
  await first.server.closed;
  await second.client.send({ type: "ping" });
  expect(await second.server.receive()).toEqual({ type: "ping" });
});

it("a daemon with every channel authorized turns a new client away as busy", async () => {
  const { connection, connect } = await host({ maxClientChannels: 1 });
  await connect();
  await expect(
    connectClientViaRelay({
      relayUrl,
      hostId: connection.hostId,
      pinnedFingerprint: connection.hostId,
    }),
  ).rejects.toThrow();
});

it("a client asking for a daemon that is not connected is refused", async () => {
  const missing = hostId(keyPair().publicKey);
  await expect(
    connectClientViaRelay({ relayUrl, hostId: missing, pinnedFingerprint: missing }),
  ).rejects.toThrow();
});

it("a key that does not own the claimed host id cannot register under it", async () => {
  const victim = hostId(keyPair().publicKey);
  const attacker = await openPeer(address(relayUrl, "/host", { hostId: victim }));
  cleanups.push(() => attacker.close());
  await initiate(attacker, CONTROL, keyPair());
  expect(await attacker.closed).toBe(1008);
  await expect(
    connectClientViaRelay({ relayUrl, hostId: victim, pinnedFingerprint: victim }),
  ).rejects.toThrow();
});

it("a newer registration of the same daemon takes over its clients", async () => {
  const hostKeys = keyPair();
  const stale: HostChannel[] = [];
  const old = await connectHostToRelay({
    relayUrl,
    hostKeys,
    onClientChannel: (channel) => void stale.push(channel),
  });
  cleanups.push(() => old.close());
  const fresh = deferred<HostChannel>();
  const current = await connectHostToRelay({ relayUrl, hostKeys, onClientChannel: fresh.resolve });
  cleanups.push(() => current.close());
  const client = await connectClientViaRelay({
    relayUrl,
    hostId: current.hostId,
    pinnedFingerprint: current.hostId,
  });
  cleanups.push(() => client.close());
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
  });
  expect(await (await fresh.promise).receive()).toMatchObject({ type: "hello" });
  expect(stale).toEqual([]);
});
