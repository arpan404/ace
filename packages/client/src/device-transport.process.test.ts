import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage, HostId } from "@ace/protocol";
import { connectHostToRelay, startRelay } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import { DeviceClient } from "@ace/devices/client";
import { authenticatedChannel, deviceTransport } from "./device-transport.ts";
import { machineCodeGate } from "./machine-code-gate.ts";

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

it("a dedicated device channel reports capacity and retries slowly without replaying commands", async () => {
  const server = new WebSocketServer({ port: 0 });
  disposals.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  let saturated = true;
  server.on("connection", (socket) => {
    socket.once("message", () => {
      if (saturated) socket.close(4013, "connection_limit");
      else
        socket.send(
          JSON.stringify({ type: "welcome", protocolVersion: 1, hostId: "host", headSeq: 0 }),
        );
    });
  });
  const timers = new Map<() => void, number>();
  const clock = (callback: () => void, delay: number) => {
    const run = () => {
      timers.delete(run);
      callback();
    };
    timers.set(run, delay);
    return () => {
      timers.delete(run);
    };
  };
  let limited = deferred<void>();
  const client = new DeviceClient({ id: () => "limited", schedule: clock });
  disposals.push(() => client.disconnect());
  const release = client.watch((state) => {
    if (state.error) limited.resolve();
  });
  disposals.push(release);
  client.connect(
    deviceTransport({
      target: { kind: "local", url: `ws://127.0.0.1:${address.port}` },
      deviceId: "human",
      credential: async () => "a".repeat(64),
      socket: (url) => new WebSocket(url),
      keys,
      schedule: clock,
    }),
  );
  await limited.promise;
  expect(client.getSnapshot()).toMatchObject({ connected: false, error: { code: "limit" } });
  expect([...timers.values()]).toEqual([5000]);
  await expect(client.request({ op: "list" })).rejects.toMatchObject({ code: "disconnected" });
  limited = deferred<void>();
  for (const callback of Array.from(timers.keys())) callback();
  await limited.promise;
  expect([...timers.values()]).toEqual([10000]);
  saturated = false;
  const connected = ready(client);
  for (const callback of Array.from(timers.keys())) callback();
  await connected;
  expect(client.getSnapshot().error).toBeUndefined();
});

it("an account device offers its grant to the relay and in hello, and sends the machine code when asked", async () => {
  const relay = await startRelay({ port: 0, bind: "127.0.0.1" });
  disposals.push(() => relay.close());
  const hostKeys = keyPair(new Uint8Array(32).fill(9));
  const hostId = HostId.parse(fingerprint(hostKeys.publicKey));
  const hellos: unknown[] = [];
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys,
    async onClientChannel(channel) {
      const first = await channel.receive();
      hellos.push(first);
      if (first.type !== "hello" || first.grant === undefined) return channel.close();
      if (first.machineCode !== "2468") {
        await channel.send({
          type: "error",
          code: first.machineCode ? "machine_code_wrong" : "machine_code_required",
          message: "Enter this machine's code.",
        });
        return channel.close();
      }
      channel.authorize();
      await channel.send({ type: "welcome", protocolVersion: 1, hostId, headSeq: 0 });
      for await (const frame of channel)
        if (frame.type === "ping") await channel.send({ type: "pong" });
    },
  });
  disposals.push(() => host.close());
  let issued = 0;
  const gate = machineCodeGate(async () => `grant-${++issued}`);
  const offered: (string[] | undefined)[] = [];
  const channel = authenticatedChannel(
    {
      target: { kind: "relay", url: relay.url, pinnedFingerprint: hostId },
      deviceId: "phone",
      credential: () => gate.credential(),
      socket: (url, protocols) => {
        offered.push(protocols);
        return new WebSocket(url, protocols);
      },
      keys,
      schedule,
    },
    "files",
  );
  disposals.push(() => channel.close());
  const opened = () => {
    const outcome = deferred<string>();
    channel.open({
      ready: () => {
        gate.welcomed();
        outcome.resolve("welcome");
      },
      message: noop,
      close: () => outcome.resolve("closed"),
      refused: (reason) => gate.refused(reason),
    });
    return outcome.promise;
  };
  expect(await opened()).toBe("closed");
  expect(gate.asking).toBe("machine_code_required");
  gate.enter("1111");
  expect(await opened()).toBe("closed");
  expect(gate.asking).toBe("machine_code_wrong");
  gate.enter("2468");
  expect(await opened()).toBe("welcome");
  expect(gate.asking).toBeUndefined();
  expect(offered).toEqual([["ace.grant.grant-1"], ["ace.grant.grant-2"], ["ace.grant.grant-3"]]);
  expect(hellos).toMatchObject([
    { grant: "grant-1", deviceId: "phone", channel: "files" },
    { grant: "grant-2", machineCode: "1111" },
    { grant: "grant-3", machineCode: "2468" },
  ]);
  expect(hellos[0]).not.toHaveProperty("machineCode");
});
