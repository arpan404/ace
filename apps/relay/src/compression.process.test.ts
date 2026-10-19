import { afterEach, expect, it } from "vitest";
import { keyPair } from "@ace/secure-channel";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { startRelay, connectClientViaRelay, connectHostToRelay } from "./index.ts";
import type { HostChannel } from "./index.ts";
import { deferred } from "./testing/peer.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function connected() {
  const relay = await startRelay({});
  cleanups.push(() => relay.close());
  const arrived = deferred<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: (channel) => arrived.resolve(channel),
  });
  cleanups.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanups.push(() => client.close());
  const server = await arrived.promise;
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "validated",
    compression: ["deflate-raw"],
  });
  await server.receive();
  server.authorize();
  return { client, server };
}

/** A long, repetitive JSON message: what console and network lists look like. */
const bulky = (code: string): ServerMessage => ({
  type: "error",
  code,
  message: "GET /api/items?page=1 200 application/json ".repeat(5000),
});

/** Bytes a send puts in flight, read before the relay socket drains them. */
function queuedBy(
  server: HostChannel,
  message: ServerMessage,
): {
  bytes: number;
  sent: Promise<void>;
} {
  const before = server.bufferedBytes;
  const sent = server.send(message);
  return { bytes: server.bufferedBytes - before, sent };
}

it("an allowed JSON message crosses the relay deflated and arrives unchanged", async () => {
  const { client, server } = await connected();
  server.compress?.((message) => message.type === "error" && message.code === "bulk");
  const message = bulky("bulk");
  const raw = new TextEncoder().encode(JSON.stringify(message)).length;
  const queued = queuedBy(server, message);
  expect(queued.bytes).toBeLessThan(raw / 10);
  await queued.sent;
  expect(await client.receive()).toEqual(message);
});

it("a message the policy refuses goes as it is, so it never shares a deflate with others", async () => {
  const { client, server } = await connected();
  server.compress?.((message) => message.type === "error" && message.code === "bulk");
  const message = bulky("secret-bearing");
  const raw = new TextEncoder().encode(JSON.stringify(message)).length;
  const queued = queuedBy(server, message);
  expect(queued.bytes).toBeGreaterThanOrEqual(raw);
  await queued.sent;
  expect(await client.receive()).toEqual(message);
});

it("without the peer asking, nothing is deflated", async () => {
  const { client, server } = await connected();
  const message = bulky("bulk");
  const raw = new TextEncoder().encode(JSON.stringify(message)).length;
  const queued = queuedBy(server, message);
  expect(queued.bytes).toBeGreaterThanOrEqual(raw);
  await queued.sent;
  expect(await client.receive()).toEqual(message);
});

it("deflated and plain messages interleave in order", async () => {
  const { client, server } = await connected();
  server.compress?.((message) => message.type === "error" && message.code === "bulk");
  const sends = [bulky("bulk"), { type: "pong" } as const, bulky("plain"), bulky("bulk")];
  await Promise.all(sends.map((message) => server.send(message)));
  for (const message of sends) expect(await client.receive()).toEqual(message);
});
