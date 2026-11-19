import { afterEach, expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import { FLOW_WINDOW, keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "./index.ts";
import type { BinaryChannel, HostChannel } from "./index.ts";
import { deferred } from "./testing/peer.ts";

// Real relay, real sockets: the self-hosted relay has its own backpressure, so what these check
// is the channels' end-to-end limit, which also holds through a relay that has none (ADR 0110).

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const MESSAGE = 60 * 1024;
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function pair(options: { flowControl: boolean }) {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = deferred<HostChannel>();
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
  const server = await arrived.promise;
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
  });
  await server.receive();
  server.authorize();
  // What the daemon does when the hello asks for `flowControl: ["credit"]`.
  if (options.flowControl) server.flowControl?.();
  // The daemon's first credit comes before its welcome; the client limits itself from there.
  await server.send({ type: "pong" });
  await client.receive();
  return { server, client };
}

/** Starts `count` numbered binary messages; tracks how many bytes the sender saw written. */
function stream(sender: Pick<BinaryChannel, "sendBinary">, count: number) {
  let written = 0;
  const sends = Array.from({ length: count }, (_, index) => {
    const message = new Uint8Array(MESSAGE).fill(index % 251);
    new DataView(message.buffer).setUint32(0, index);
    return sender.sendBinary(message).then(() => void (written += MESSAGE));
  });
  return { all: Promise.all(sends), written: () => written };
}

async function drain(receiver: Pick<BinaryChannel, "receiveBinary">, count: number) {
  for (let index = 0; index < count; index++) {
    const message = await receiver.receiveBinary();
    expect(message.length).toBe(MESSAGE);
    expect(new DataView(message.buffer, message.byteOffset).getUint32(0)).toBe(index);
    expect(message[MESSAGE - 1]).toBe(index % 251);
  }
}

it("a stalled reader holds the sender to one window, and every message arrives in order once it reads", async () => {
  const { server, client } = await pair({ flowControl: true });
  const count = 96; // 5.6 MiB
  const sent = stream(server, count);
  await settle();
  // Written means handed to the socket: at most a window of fragments past what was consumed.
  expect(sent.written()).toBeLessThanOrEqual(FLOW_WINDOW + MESSAGE);
  expect(server.bufferedBytes).toBeGreaterThan(count * MESSAGE - FLOW_WINDOW - 2 * MESSAGE);
  await drain(client, count);
  await sent.all;
  expect(server.bufferedBytes).toBe(0);
});

it("both directions stalled at once still deliver everything: credits never wait behind data", async () => {
  const { server, client } = await pair({ flowControl: true });
  const count = 48;
  const down = stream(server, count);
  const up = stream(client, count);
  await settle();
  expect(down.written()).toBeLessThanOrEqual(FLOW_WINDOW + MESSAGE);
  expect(up.written()).toBeLessThanOrEqual(FLOW_WINDOW + MESSAGE);
  await Promise.all([drain(client, count), drain(server, count)]);
  await Promise.all([down.all, up.all]);
});

it("a reader that keeps up receives a long stream without stalling the sender", async () => {
  const { server, client } = await pair({ flowControl: true });
  const count = 512; // 30 MiB, many windows; sent one at a time, as the daemon's outbox does
  const sending = (async () => {
    for (let index = 0; index < count; index++) {
      const message = new Uint8Array(MESSAGE).fill(index % 251);
      new DataView(message.buffer).setUint32(0, index);
      await server.sendBinary(message);
    }
  })();
  await drain(client, count);
  await sending;
});

it("without flow control a stalled reader leaves the sender unbounded by the channel", async () => {
  // The old behaviour, kept for peers that never asked: only the relay's backpressure applies.
  const { server, client } = await pair({ flowControl: false });
  const count = 96;
  const sent = stream(server, count);
  await settle();
  expect(sent.written()).toBeGreaterThan(FLOW_WINDOW + MESSAGE);
  await drain(client, count);
  await sent.all;
});
