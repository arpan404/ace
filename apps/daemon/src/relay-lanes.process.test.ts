import { afterEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
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

async function relayedMain(lanes: boolean) {
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
  });
  await channel.receive();
  channel.authorize();
  // What `files-relay.ts` does for this hello.
  channel.flowControl?.();
  if (lanes) channel.lanes?.();
  const socket = new RelaySocket(channel, { deflate: false, delay: () => () => {} });
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
