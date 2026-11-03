import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DeviceId } from "@ace/protocol";
import { connectHostToRelay, startRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { FLOW_WINDOW, keyPair } from "@ace/secure-channel";
import { connectPortableRelay } from "./portable-relay.ts";

// The browser and iPhone relay client against a real relay and the daemon's own host channel.
// The client can't pause its socket, so without credit a reader that falls a megabyte behind is
// closed; with it, the daemon waits instead.

const disposals: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose();
});
const MESSAGE = 60 * 1024;

async function connect(options: { flowControl: boolean }) {
  const relay = await startRelay();
  disposals.push(() => relay.close());
  const arrived = Promise.withResolvers<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: arrived.resolve,
  });
  disposals.push(() => host.close());
  const client = await connectPortableRelay({
    relayUrl: relay.url,
    pinnedFingerprint: host.hostId,
    socket: (url, protocols) => new WebSocket(url, protocols),
    keys: () => ({ staticKey: keyPair(), ephemeralKey: keyPair() }),
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  });
  disposals.push(() => client.close());
  const server = await arrived.promise;
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
    ...(options.flowControl ? { flowControl: ["credit"] } : {}),
  });
  const hello = await server.receive();
  server.authorize();
  if (hello.type === "hello" && hello.flowControl?.includes("credit")) server.flowControl?.();
  return { server, client };
}

function stream(server: HostChannel, count: number) {
  let written = 0;
  const sends = Array.from({ length: count }, (_, index) => {
    const message = new Uint8Array(MESSAGE).fill(index % 251);
    new DataView(message.buffer).setUint32(0, index);
    return server.sendBinary(message).then(() => void (written += MESSAGE));
  });
  return { all: Promise.all(sends), written: () => written };
}

it("a client that stops reading holds the daemon to one window, then gets every message in order", async () => {
  const { server, client } = await connect({ flowControl: true });
  const count = 96;
  const sent = stream(server, count);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(sent.written()).toBeLessThanOrEqual(FLOW_WINDOW + MESSAGE);
  for (let index = 0; index < count; index++) {
    const message = await client.receive();
    if (!(message instanceof Uint8Array)) throw new Error("Expected binary");
    expect(new DataView(message.buffer, message.byteOffset).getUint32(0)).toBe(index);
    expect(message[MESSAGE - 1]).toBe(index % 251);
  }
  await sent.all;
});

it("without credit, a client that falls a megabyte behind is cut off", async () => {
  const { server, client } = await connect({ flowControl: false });
  const sent = stream(server, 96);
  await expect(sent.all).rejects.toThrow();
  await expect(client.receive()).rejects.toThrow();
});
