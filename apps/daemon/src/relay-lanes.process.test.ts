import { afterEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { slowLink } from "@ace/relay/testing/slow-link";
import { Outbox, defaultPressure } from "./outbox.ts";
import { RelaySocket } from "./relay-socket.ts";

// The daemon's own outbox and relay socket, a real relay, and a phone behind a slow link: the
// outbox stops handing messages over while the socket reports pressure, so this checks that a
// reply sent after a snapshot reaches the phone first when it announced lanes.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function relayedMain(lanes: boolean, deflate?: (json: Uint8Array) => Promise<Uint8Array>) {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  // 2 Mbit/s and 200 ms round trips: the snapshot alone takes about four seconds.
  const proxy = await slowLink(relay.url, { bytesPerSecond: 250_000, roundTripMs: 200 });
  cleanup.push(() => proxy.close());
  const arrived = Promise.withResolvers<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: arrived.resolve,
    ...(deflate ? { deflate } : {}),
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: proxy.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  const channel = await arrived.promise;
  if (lanes) client.lanes?.();
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
    flowControl: lanes ? ["credit", "lanes"] : ["credit"],
    compression: ["deflate-raw"],
  });
  await channel.receive();
  channel.authorize();
  // What `files-relay.ts` does for this hello.
  channel.flowControl?.();
  if (lanes) channel.lanes?.();
  const socket = new RelaySocket(channel, { deflate: true, delay: () => () => {} });
  // The client's subscriptions reach the socket as they would the daemon's handler.
  const subscribed = Promise.withResolvers<void>();
  let seen = 0;
  socket.on("message", () => {
    if (++seen === 3) subscribed.resolve();
  });
  socket.start(JSON.stringify({ type: "hello" }));
  for (const [subscriptionId, threadId] of [
    ["sa", "a"],
    ["sb", "b"],
  ])
    await client.sendText(
      JSON.stringify({ type: "subscribe", subscriptionId, scope: { kind: "thread", threadId } }),
    );
  await subscribed.promise;
  return { socket, client };
}

/** How long a reply queued after a 1 MiB snapshot takes to reach the phone. */
async function replyWait(lanes: boolean): Promise<{ waitMs: number; order: string[] }> {
  const { socket, client } = await relayedMain(lanes);
  const outbox = new Outbox(socket, defaultPressure);
  const snapshot = {
    type: "snapshot",
    subscriptionId: "thread-a",
    seq: 1,
    view: { kind: "thread", blob: randomBytes(700 * 1024).toString("base64") },
  } as unknown as ServerMessage; // Only its size and ids matter to the outbox.
  outbox.send(snapshot);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const queuedAt = performance.now();
  outbox.send({ type: "pong" });
  const order: string[] = [];
  let waitMs = 0;
  while (order.length < 2) {
    const text = await client.receiveRaw();
    const type = typeof text === "string" ? /^\{"type":"([^"]+)"/.exec(text)?.[1] : undefined;
    order.push(type ?? "binary");
    if (type === "pong") waitMs = performance.now() - queuedAt;
  }
  return { waitMs, order };
}

it("a reply queued after a snapshot waits for all of it without lanes, and not with them", async () => {
  const before = await replyWait(false);
  expect(before.order).toEqual(["snapshot", "pong"]);
  expect(before.waitMs).toBeGreaterThan(2500);
  const after = await replyWait(true);
  expect(after.order).toEqual(["pong", "snapshot"]);
  expect(after.waitMs).toBeLessThan(1500);
}, 30_000);

const typeOf = (text: string | Uint8Array) =>
  typeof text === "string" ? (/^\{"type":"([^"]+)"/.exec(text)?.[1] ?? "?") : "binary";

it("a sidebar patch saying a thread is done never reaches the phone before that thread's output", async () => {
  const { socket, client } = await relayedMain(true);
  socket.send(
    `{"type":"snapshot","subscriptionId":"sa","seq":1,"view":{"pad":"${"s".repeat(400_000)}"}}`,
  );
  socket.send(
    '{"type":"events","subscriptionId":"sa","events":[{"threadId":"a","payload":{"type":"item.created"}},{"threadId":"a","payload":{"type":"run.ended"}}]}',
  );
  socket.send('{"type":"threads.patch","subscriptionId":"side","seq":2,"done":"a"}');
  const order = [];
  for (let index = 0; index < 3; index++) order.push(typeOf(await client.receiveRaw()));
  expect(order).toEqual(["snapshot", "events", "threads.patch"]);
}, 30_000);

it("a close waits for a message sent before it that is still being deflated", async () => {
  // A deflate that takes far longer than the close needs to go out.
  const slow = async (json: Uint8Array) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return deflateRawSync(json);
  };
  const { socket, client } = await relayedMain(true, slow);
  const big = `{"type":"events","subscriptionId":"sb","pad":"${"e".repeat(300_000)}","events":[]}`;
  socket.send(big, { compress: true });
  socket.close(4000, "Reconnect with afterSeq");
  expect(await client.receiveRaw()).toBe(big);
  expect(typeOf(await client.receiveRaw())).toBe("channel.close");
}, 30_000);
