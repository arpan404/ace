import { afterEach, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "./index.ts";
import type { HostChannel } from "./index.ts";
import { deferred } from "./testing/peer.ts";

// Large JSON messages deflate off the event loop, and still go strictly in order: one being
// deflated holds back everything queued after it. A real relay and real channels.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function connected(deflate?: (json: Uint8Array) => Promise<Uint8Array>) {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = deferred<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: arrived.resolve,
    ...(deflate ? { deflate } : {}),
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  const server = await arrived.promise;
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
    compression: ["deflate-raw"],
  });
  await server.receive();
  server.authorize();
  return { client, server };
}

/** JSON text of about `bytes` that deflates well, tagged so the reader can tell it apart. */
const bulky = (tag: string, bytes: number) =>
  JSON.stringify({ type: "pong", tag, data: `${tag} line of output `.repeat(bytes / 24) });
const tagOf = (text: string | Uint8Array) =>
  typeof text === "string" ? (JSON.parse(text) as { tag?: string }).tag : "binary";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("a large message deflates off the event loop and holds back what was sent after it", async () => {
  // Also guards a past bug: the compress flag shadowed the deflate, so large messages never
  // reached it (they failed to send; with the fallback they would now go uncompressed).
  const release = Promise.withResolvers<void>();
  const { client, server } = await connected(async (json) => {
    await release.promise;
    return deflateRawSync(json);
  });
  const big = bulky("big", 2 * 1024 * 1024);
  const sends = [server.sendText(big, true), server.sendText(bulky("small", 2000), true)];
  // The event loop keeps running while the deflate is out, and nothing has gone ahead of it.
  await sleep(100);
  let early: string | undefined;
  void client.receiveRaw().then((text) => (early = tagOf(text)));
  await sleep(100);
  expect(early).toBeUndefined();
  release.resolve();
  await Promise.all(sends);
  await sleep(50);
  expect(early).toBe("big");
  expect(tagOf(await client.receiveRaw())).toBe("small");
});

it("messages keep their order through slow deflates of different lengths", async () => {
  const { client, server } = await connected(async (json) => {
    // The first large message takes longest: a later one finishing first must still wait.
    await sleep(json.length > 3 * 1024 * 1024 ? 300 : 20);
    return deflateRawSync(json);
  });
  const texts = [
    bulky("first", 4 * 1024 * 1024),
    bulky("tiny", 100),
    bulky("second", 512 * 1024),
    bulky("mid", 50_000),
  ];
  const sends = texts.map((text) => server.sendText(text, true));
  for (const text of texts) expect(await client.receiveRaw()).toBe(text);
  await Promise.all(sends);
});

it("a deflate that fails sends the message as it is, still in order", async () => {
  const { client, server } = await connected(async () => {
    throw new Error("deflate failed");
  });
  const texts = [bulky("big", 1024 * 1024), bulky("after", 100)];
  const sends = texts.map((text) => server.sendText(text, true));
  for (const text of texts) expect(await client.receiveRaw()).toBe(text);
  await Promise.all(sends);
});

it("a large message sent with compression arrives whole through the real deflate", async () => {
  const { client, server } = await connected();
  const big = bulky("big", 8 * 1024 * 1024);
  const sent = server.sendText(big, true);
  expect(await client.receiveRaw()).toBe(big);
  await sent;
});
