import { afterEach, expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { ServerMessage } from "@ace/protocol";
import { Outbox, defaultPressure } from "./outbox.ts";
import { eventFrameBytes } from "./wire-encoder.ts";
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

async function relayedMain(deflate?: (json: Uint8Array) => Promise<Uint8Array>) {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = Promise.withResolvers<HostChannel>();
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

it("a close right after a message whose deflate is slow loses nothing: the goodbye comes after it", async () => {
  const { channel, client } = await relayedMain(async (json) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return deflateRawSync(json);
  });
  const timers = manualDelay();
  const socket = new RelaySocket(channel, { deflate: true, delay: timers.delay });
  const big = JSON.stringify({ type: "pong", pad: "output line ".repeat(50_000) });
  socket.send(big, { compress: true });
  socket.close(4000, "Reconnect with afterSeq");
  expect(await client.receiveRaw()).toBe(big);
  expect((await client.receive()).type).toBe("channel.close");
  await client.closed;
});

/** JSON text of exactly `bytes` bytes that deflates well. */
function compressible(bytes: number): string {
  const head = '{"type":"pong","data":"';
  return `${head}${"line of output ".repeat(bytes / 15 + 1).slice(0, bytes - head.length - 2)}"}`;
}

it("a 16 MiB message closed at once still arrives, then the goodbye", async () => {
  const { channel, client } = await relayedMain();
  const socket = new RelaySocket(channel, { deflate: true, delay: manualDelay().delay });
  const big = compressible(16 * 1024 * 1024);
  socket.send(big, { compress: true });
  socket.close(4000, "Reconnect with afterSeq");
  expect(await client.receiveRaw()).toBe(big);
  expect((await client.receive()).type).toBe("channel.close");
  await client.closed;
}, 30_000);

it("with the queue full behind a reader that stopped, a close loses nothing it queued", async () => {
  const { channel, client } = await relayedMain();
  const socket = new RelaySocket(channel, { deflate: true, delay: manualDelay().delay });
  const errors: string[] = [];
  // About 16 MiB of base64 (which deflates by only a quarter), then 16 MiB that deflates well,
  // while the reader reads nothing: the later ones no longer fit undeflated and are deflated
  // at once, then queued.
  const texts = [
    ...Array.from({ length: 4 }, (_, index) =>
      JSON.stringify({ type: "pong", index, pad: randomBytes(3 * 1024 * 1024).toString("base64") }),
    ),
    compressible(16 * 1024 * 1024),
  ];
  for (const text of texts)
    socket.send(text, { compress: true }, (error) => error && errors.push(error.message));
  socket.close(4000, "Reconnect with afterSeq");
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const text of texts) expect(await client.receiveRaw()).toBe(text);
  expect((await client.receive()).type).toBe("channel.close");
  expect(errors).toEqual([]);
  await client.closed;
}, 30_000);

it("sends left unanswered when the channel ends raise no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const listen = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  try {
    const release = Promise.withResolvers<void>();
    const { channel } = await relayedMain(async (json) => {
      await release.promise;
      return deflateRawSync(json);
    });
    const socket = new RelaySocket(channel, { deflate: true, delay: manualDelay().delay });
    // As the outbox's frame holder sends and as fire-and-forget callers do: no callback.
    socket.send(compressible(2 * 1024 * 1024), { compress: true });
    socket.send(JSON.stringify({ type: "pong" }));
    socket.send(new Uint8Array(1024), { binary: true });
    socket.terminate();
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(channel.unsentMessages).toBe(0);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listen);
  }
});

/** The largest frame the outbox sends: a reply of twice an event frame (`outbox.ts`). */
const replyFrameBytes = eventFrameBytes * 2;

it("the outbox handing over its largest frames at its own pause point is never refused", async () => {
  const { channel, client } = await relayedMain();
  const socket = new RelaySocket(channel, { deflate: true, delay: manualDelay().delay });
  const outbox = new Outbox(socket, defaultPressure);
  // Frames as large as the outbox sends (2 MiB), to a reader that reads nothing for now: the
  // outbox hands one over below its 256 KiB pause point and holds the rest.
  const frames = Array.from({ length: 3 }, (_, index) => ({
    type: "turns.page",
    requestId: `r${index}`,
    pad: "line of output ".repeat((replyFrameBytes - 200) / 15),
  }));
  for (const frame of frames) outbox.send(frame as unknown as ServerMessage);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(channel.bufferedBytes).toBeLessThanOrEqual(256 * 1024 + replyFrameBytes + 64 * 1024);
  for (const frame of frames) expect(JSON.parse(String(await client.receiveRaw()))).toEqual(frame);
  expect(socket.readyState).toBe(1);
}, 30_000);
