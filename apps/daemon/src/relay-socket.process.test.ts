import { afterEach, expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { RelaySocket } from "./relay-socket.ts";

// A real relay and real channels: what's checked is when the device's end of a relayed main
// channel actually ends after the daemon closes it.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Timers fired by hand. */
function manualDelay() {
  const pending: (() => void)[] = [];
  return {
    delay: (callback: () => void) => {
      pending.push(callback);
      return () => {
        const index = pending.indexOf(callback);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    fire: () => {
      for (const callback of pending.splice(0)) callback();
    },
  };
}

async function relayedMain() {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = Promise.withResolvers<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: arrived.resolve,
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  const channel = await arrived.promise;
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
    flowControl: ["credit"],
  });
  await channel.receive();
  channel.authorize();
  channel.flowControl?.();
  return { channel, client };
}

it("a device that stopped reading is cut off once the close grace ends, though its goodbye can't get out", async () => {
  const { channel, client } = await relayedMain();
  const timers = manualDelay();
  const socket = new RelaySocket(channel, { deflate: false, delay: timers.delay });
  // More than a flow window of events the device never reads.
  for (let index = 0; index < 40; index++)
    socket.send(JSON.stringify({ type: "pong", pad: "x".repeat(60_000) }));
  socket.close(4000, "Reconnect with afterSeq");
  const ended = await Promise.race([
    client.closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 300)),
  ]);
  expect(ended).toBe(false);
  timers.fire();
  await client.closed;
});

it("a device that keeps reading gets every message and then the goodbye", async () => {
  const { channel, client } = await relayedMain();
  const timers = manualDelay();
  const socket = new RelaySocket(channel, { deflate: false, delay: timers.delay });
  for (let index = 0; index < 40; index++) socket.send(JSON.stringify({ type: "pong" }));
  socket.close(4000, "Reconnect with afterSeq");
  const received: string[] = [];
  for (let index = 0; index < 41; index++) received.push((await client.receive()).type);
  expect(received.slice(0, 40).every((type) => type === "pong")).toBe(true);
  expect(received[40]).toBe("channel.close");
  await client.closed;
});
