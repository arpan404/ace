import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage, HostId } from "@ace/protocol";
import { connectHostToRelay, startRelay } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import { DeviceClient } from "@ace/devices/client";
import { deviceTransport } from "./device-transport.ts";

const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose();
});
const schedule = (callback: () => void, delay: number) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};
const keys = () => ({
  staticKey: keyPair(new Uint8Array(32).fill(3)),
  ephemeralKey: keyPair(new Uint8Array(32).fill(4)),
});
function noop() {}
function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function ready(client: DeviceClient) {
  return new Promise<void>((resolve) => {
    let release = noop;
    release = client.watch((value) => {
      if (value.connected) {
        release();
        resolve();
      }
    });
  });
}

it("authenticates a dedicated local device channel before forwarding human commands", async () => {
  const server = new WebSocketServer({ port: 0 });
  disposals.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing address");
  const hello = deferred<unknown>();
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = ClientMessage.parse(JSON.parse(data.toString()));
      if (frame.type === "hello") {
        hello.resolve(frame);
        socket.send(
          JSON.stringify({ type: "welcome", protocolVersion: 1, hostId: "host", headSeq: 0 }),
        );
      } else if (frame.type === "devices.request")
        socket.send(
          JSON.stringify({
            type: "devices.result",
            requestId: frame.requestId,
            ok: true,
            data: { devices: [], issues: [] },
          }),
        );
    });
  });
  const client = new DeviceClient({ id: () => "request-local", schedule });
  disposals.push(() => client.disconnect());
  client.connect(
    deviceTransport({
      target: { kind: "local", url: `ws://127.0.0.1:${address.port}/` },
      deviceId: "human",
      credential: async () => "a".repeat(64),
      socket: (url) => new WebSocket(url),
      keys,
      schedule,
    }),
  );
  expect(await hello.promise).toMatchObject({
    type: "hello",
    channel: "devices",
    deviceId: "human",
    token: "a".repeat(64),
  });
  await ready(client);
  expect(await client.request({ op: "list" })).toEqual({ devices: [], issues: [] });
});

it("routes paired phone credentials and device commands through the pinned encrypted relay", async () => {
  const relay = await startRelay({ port: 0, bind: "127.0.0.1" });
  disposals.push(() => relay.close());
  const hostKeys = keyPair(new Uint8Array(32).fill(8));
  const hostId = HostId.parse(fingerprint(hostKeys.publicKey));
  const hello = deferred<unknown>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys,
    async onClientChannel(channel) {
      const first = await channel.receive();
      hello.resolve(first);
      if (
        first.type !== "hello" ||
        first.deviceId !== "paired-admin" ||
        first.token !== "b".repeat(64)
      ) {
        channel.close();
        return;
      }
      channel.authorize();
      await channel.send({ type: "welcome", protocolVersion: 1, hostId, headSeq: 0 });
      for await (const frame of channel) {
        if (frame.type === "devices.request")
          await channel.send({
            type: "devices.result",
            requestId: frame.requestId,
            ok: true,
            data: { devices: [], issues: [] },
          });
        else if (frame.type === "ping") await channel.send({ type: "pong" });
      }
    },
  });
  disposals.push(() => host.close());
  const client = new DeviceClient({ id: () => "relay-request", schedule });
  disposals.push(() => client.disconnect());
  client.connect(
    deviceTransport({
      target: { kind: "relay", url: relay.url, pinnedFingerprint: hostId },
      deviceId: "paired-admin",
      credential: async () => "b".repeat(64),
      socket: (url) => new WebSocket(url),
      keys,
      schedule,
    }),
  );
  await ready(client);
  expect(await hello.promise).toMatchObject({
    channel: "devices",
    deviceId: "paired-admin",
    token: "b".repeat(64),
  });
  expect(await client.request({ op: "list" })).toEqual({ devices: [], issues: [] });
});

it("rejects commands until a validated welcome and closes on unauthenticated binary input", async () => {
  const server = new WebSocketServer({ port: 0 });
  disposals.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing address");
  const closed = deferred<void>();
  server.on("connection", (socket) => {
    socket.once("message", () => socket.send(new Uint8Array([1, 2, 3])));
    socket.once("close", () => closed.resolve());
  });
  const client = new DeviceClient({ id: () => "unauthenticated", schedule });
  disposals.push(() => client.disconnect());
  client.connect(
    deviceTransport({
      target: { kind: "local", url: `ws://127.0.0.1:${address.port}` },
      deviceId: "human",
      credential: async () => "a".repeat(64),
      socket: (url) => new WebSocket(url),
      keys,
      schedule,
    }),
  );
  await expect(client.request({ op: "list" })).rejects.toMatchObject({ code: "disconnected" });
  await closed.promise;
  expect(client.getSnapshot().connected).toBe(false);
});
