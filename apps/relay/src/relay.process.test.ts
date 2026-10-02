import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { keyPair, hostId, NoiseXX } from "@ace/secure-channel";
import { startRelay, connectClientViaRelay, connectHostToRelay } from "./index.ts";
import { DeviceId } from "@ace/protocol";
import type { HostChannel } from "./index.ts";
import {
  openPeer as dial,
  address as relayAddress,
  initiate,
  CONTROL as CONTROL_PROLOGUE,
  STREAM as STREAM_PROLOGUE,
  bytes,
  json,
  Registration,
  Offer,
  deferred,
  sendFrame,
} from "./testing/peer.ts";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function setup(options: Parameters<typeof startRelay>[0] = {}) {
  const relay = await startRelay(options);
  cleanups.push(() => relay.close());
  const hostKeys = keyPair();
  const incoming: HostChannel[] = [];
  let waiter = deferred<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys,
    onClientChannel(channel) {
      incoming.push(channel);
      waiter.resolve(channel);
    },
  });
  cleanups.push(() => host.close());
  async function connect(relayUrl = relay.url) {
    waiter = deferred<HostChannel>();
    const client = await connectClientViaRelay({
      relayUrl,
      hostId: host.hostId,
      pinnedFingerprint: host.hostId,
    });
    cleanups.push(() => client.close());
    const server = await waiter.promise;
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("paired"),
      token: "validated",
    });
    await server.receive();
    server.authorize();
    return { client, server };
  }
  return { relay, hostKeys, host, connect, incoming };
}
function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}
it("authenticated hosts accept multiple outbound client streams with independent daemon messages", async () => {
  const { connect } = await setup();
  const first = await connect(),
    second = await connect();
  await first.client.send({ type: "ping" });
  await second.client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "secret device token",
  });
  expect(await first.server.receive()).toEqual({ type: "ping" });
  expect(await second.server.receive()).toMatchObject({ token: "secret device token" });
  await first.server.send({ type: "pong" });
  expect(await first.client.receive()).toEqual({ type: "pong" });
  first.client.close();
  await first.server.closed;
  await second.server.send({ type: "pong" });
  expect(await second.client.receive()).toEqual({ type: "pong" });
});
it("registration proves possession of the static key and ignores a claimed host id", async () => {
  const { relay, host, connect } = await setup();
  const attackerKeys = keyPair();
  const attacker = await dial(relayAddress(relay.url, "/host", { hostId: host.hostId }));
  cleanups.push(() => attacker.socket.terminate());
  const auth = await initiate(attacker, CONTROL_PROLOGUE, attackerKeys);
  cleanups.push(() => auth.destroy());
  const registration = Registration.parse(json(auth.receive.decrypt(await attacker.next())));
  expect(registration.hostId).toBe(hostId(attackerKeys.publicKey));
  expect(registration.hostId).not.toBe(host.hostId);
  const { client, server } = await connect();
  await client.send({ type: "ping" });
  expect(await server.receive()).toEqual({ type: "ping" });
});
it("replayed registration transcripts do not prove possession to a fresh relay handshake", async () => {
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  const keys = keyPair();
  const noise = new NoiseXX({
    ephemeralKey: keyPair(),
    initiator: true,
    staticKey: keys,
    prologue: CONTROL_PROLOGUE,
  });
  const first = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => first.socket.terminate());
  const m1 = noise.writeMessage();
  await sendFrame(first.socket, m1);
  noise.readMessage(await first.next());
  const m3 = noise.writeMessage();
  await sendFrame(first.socket, m3);
  await first.next();
  const replay = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => replay.socket.terminate());
  const ended = closed(replay.socket);
  await sendFrame(replay.socket, m1);
  await replay.next();
  await sendFrame(replay.socket, m3);
  expect(await ended).toBe(1006);
});
it("an impersonating relay is rejected by the pinned responder fingerprint", async () => {
  const pinned = hostId(keyPair().publicKey);
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", r));
  cleanups.push(() => {
    for (const s of wss.clients) s.terminate();
    return new Promise<void>((r) => wss.close(() => r()));
  });
  wss.on("connection", (socket) => {
    socket.send(new Uint8Array([1]));
    const noise = new NoiseXX({
      ephemeralKey: keyPair(),
      initiator: false,
      staticKey: keyPair(),
      prologue: STREAM_PROLOGUE,
    });
    socket.once("message", (data) => {
      noise.readMessage(bytes(data));
      socket.send(noise.writeMessage());
    });
  });
  const addr = wss.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  await expect(
    connectClientViaRelay({
      relayUrl: `ws://127.0.0.1:${addr.port}`,
      hostId: pinned,
      pinnedFingerprint: pinned,
    }),
  ).rejects.toThrow("fingerprint");
});
async function proxy(
  upstream: string,
  inspect: (path: string, direction: "in" | "out", frame: Buffer, index: number) => Buffer,
) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 65535 });
  await new Promise<void>((r) => wss.once("listening", r));
  const peers = new Set<WebSocket>();
  cleanups.push(() => {
    for (const p of peers) p.terminate();
    for (const p of wss.clients) p.terminate();
    return new Promise<void>((r) => wss.close(() => r()));
  });
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", upstream);
    const peer = new WebSocket(url);
    peers.add(peer);
    let incoming = 0,
      outgoing = 0;
    socket.on("error", () => {});
    peer.on("error", () => socket.terminate());
    socket.pause();
    socket.on("message", (data, binary) =>
      peer.send(inspect(url.pathname, "out", bytes(data), outgoing++), { binary }),
    );
    peer.on("message", (data, binary) =>
      socket.send(inspect(url.pathname, "in", bytes(data), incoming++), { binary }),
    );
    peer.once("open", () => socket.resume());
    socket.once("close", () => peer.terminate());
    peer.once("close", () => {
      peers.delete(peer);
      socket.terminate();
    });
  });
  const addr = wss.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return `ws://127.0.0.1:${addr.port}`;
}
it("a relay in the middle sees ciphertext and its modified transport frames are detected", async () => {
  const { relay, connect } = await setup();
  const frames: Buffer[] = [];
  const url = await proxy(relay.url, (path, direction, frame, index) => {
    frames.push(frame.slice());
    if (path === "/client" && direction === "in" && index === 2) {
      const modified = frame.slice();
      modified[10] = (modified[10] ?? 0) ^ 1;
      return modified;
    }
    return frame;
  });
  const { client, server } = await connect(url);
  const receive = client.receive();
  const secret = "daemon secret plaintext never visible at relay";
  await server.send({ type: "error", code: "test", message: secret });
  await expect(receive).rejects.toThrow();
  expect(frames.length).toBeGreaterThan(3);
  for (const frame of frames) expect(frame.includes(Buffer.from(secret))).toBe(false);
  expect(await client.closed).toBeInstanceOf(Error);
});
it("per-IP concurrent connection limits reject upgrades and release slots on close", async () => {
  const relay = await startRelay({ limits: { maxConnectionsPerIp: 1 } });
  cleanups.push(() => relay.close());
  const first = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => first.socket.terminate());
  await expect(dial(relayAddress(relay.url, "/host"))).rejects.toThrow("429");
  const ended = closed(first.socket);
  first.socket.terminate();
  await ended;
  const next = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => next.socket.terminate());
});
it("oversized binary frames and text frames are closed before forwarding", async () => {
  const relay = await startRelay({ limits: { maxFrameSize: 256 } });
  cleanups.push(() => relay.close());
  const large = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => large.socket.terminate());
  const ended = closed(large.socket);
  await sendFrame(large.socket, new Uint8Array(257));
  expect(await ended).toBe(1009);
  const text = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => text.socket.terminate());
  const textEnded = closed(text.socket);
  text.socket.send("plaintext");
  expect(await textEnded).toBe(1003);
});
it("idle connections expire using monotonic time", async () => {
  let now = 0;
  const relay = await startRelay({ now: () => now, limits: { idleTimeoutMs: 10000 } });
  cleanups.push(() => relay.close());
  const idle = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => idle.socket.terminate());
  const ended = closed(idle.socket);
  now = 10001;
  relay.sweep();
  expect(await ended).toBe(1006);
});
it("10 MB crosses the relay under backpressure with bounded buffers and reverse traffic", async () => {
  const paused = deferred<number>();
  const { relay, connect } = await setup({
    limits: { highWaterBytes: 16 * 1024 },
    onBackpressure: (n) => paused.resolve(n),
  });
  const { client, server } = await connect();
  const payload = "x".repeat(10 * 1024 * 1024);
  const sending = server.send({ type: "error", code: "bulk", message: payload });
  await paused.promise;
  // The application queue must refuse a second 10 MiB send while the first is blocked.
  await expect(server.send({ type: "error", code: "overflow", message: payload })).rejects.toThrow(
    "send queue too large",
  );
  expect(client.bufferedReceiveBytes).toBeLessThanOrEqual(1024 * 1024);
  await client.send({ type: "ping" });
  expect(await server.receive()).toEqual({ type: "ping" });
  const message = await client.receive();
  expect(message).toEqual({ type: "error", code: "bulk", message: payload });
  await sending;
  expect(server.bufferedBytes).toBe(0);
  expect(relay.stats.pausedReaders).toBeGreaterThan(0);
  expect(relay.stats.peakBufferedBytes).toBeLessThanOrEqual(1024 * 1024);
});
it("host registration reconnects after a relay restart and new client channels use fresh handshakes", async () => {
  const { relay, host, connect } = await setup();
  const { client, server } = await connect();
  const registered = host.whenRegistered(host.generation);
  const port = relay.port;
  await relay.close();
  // Remove the already closed relay from cleanup, retaining host ownership.
  cleanups.shift();
  await client.closed;
  await server.closed;
  const restarted = await startRelay({ port });
  cleanups.unshift(() => restarted.close());
  expect(await registered).toBe(2);
  const fresh = await connect();
  await fresh.client.send({ type: "ping" });
  expect(await fresh.server.receive()).toEqual({ type: "ping" });
});
it("cancelling host startup closes retries and rejects registration waiters", async () => {
  const relay = await startRelay();
  const url = relay.url;
  await relay.close();
  const controller = new AbortController();
  const connecting = connectHostToRelay({
    relayUrl: url,
    hostKeys: keyPair(),
    onClientChannel() {},
    signal: controller.signal,
  });
  controller.abort();
  await expect(connecting).rejects.toThrow("closed");
});
it("oversized logical messages are rejected without damaging a usable channel", async () => {
  const { connect } = await setup();
  const { client, server } = await connect();
  await expect(
    server.send({ type: "error", code: "big", message: "x".repeat(16 * 1024 * 1024) }),
  ).rejects.toThrow("too large");
  await server.send({ type: "pong" });
  expect(await client.receive()).toEqual({ type: "pong" });
});
it("stream tickets are single-use and expire before an unauthenticated join can consume them", async () => {
  let now = 0;
  const relay = await startRelay({ now: () => now });
  cleanups.push(() => relay.close());
  const keys = keyPair();
  const host = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => host.socket.terminate());
  const auth = await initiate(host, CONTROL_PROLOGUE, keys);
  cleanups.push(() => auth.destroy());
  auth.receive.decrypt(await host.next());
  async function ticket() {
    const client = await dial(
      relayAddress(relay.url, "/client", { hostId: hostId(keys.publicKey) }),
    );
    cleanups.push(() => client.socket.terminate());
    const offer = Offer.parse(json(auth.receive.decrypt(await host.next())));
    return { client, value: offer.ticket };
  }
  const first = await ticket();
  const joined = await dial(relayAddress(relay.url, "/join", { ticket: first.value }));
  cleanups.push(() => joined.socket.terminate());
  expect(await first.client.next()).toEqual(Buffer.from([1]));
  const replay = await dial(relayAddress(relay.url, "/join", { ticket: first.value }));
  cleanups.push(() => replay.socket.terminate());
  expect(await closed(replay.socket)).toBe(1008);
  const stale = await ticket();
  const staleClosed = closed(stale.client.socket);
  now = 10001;
  const expired = await dial(relayAddress(relay.url, "/join", { ticket: stale.value }));
  cleanups.push(() => expired.socket.terminate());
  expect(await closed(expired.socket)).toBe(1008);
  expect(await staleClosed).toBe(1008);
});
