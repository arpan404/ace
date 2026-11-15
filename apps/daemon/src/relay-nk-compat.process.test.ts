import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer, WebSocket as Ws } from "ws";
import { Client, relayRoute, type PortableSocket } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import { DeviceId, HostId } from "@ace/protocol";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { fixture } from "./socket-test-support.ts";

// Old and new clients and daemons over the self-hosted relay (ADR 0155, step 2): each pair
// connects, NK is used only when both ends take it, and a relay can force XX but nothing else.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Client sockets, each with the sizes of the binary frames it sent. */
function recordedSockets() {
  const dials: { sent: number[]; close(): void }[] = [];
  const socket = (url: string, protocols?: string[]): PortableSocket => {
    const real = browserDeviceSocket(url, protocols);
    const dial = { sent: [] as number[], close: () => real.close() };
    dials.push(dial);
    return {
      get binaryType() {
        return real.binaryType;
      },
      set binaryType(value: string) {
        real.binaryType = value;
      },
      get bufferedAmount() {
        return real.bufferedAmount;
      },
      get protocol() {
        return real.protocol ?? "";
      },
      addEventListener: real.addEventListener.bind(real),
      send(data: string | Uint8Array) {
        dial.sent.push(typeof data === "string" ? data.length : data.length);
        real.send(data);
      },
      close: () => real.close(),
    };
  };
  /** Which handshake each dial opened with: an XX first message is exactly 32 bytes. */
  const patterns = () => dials.map((dial) => (dial.sent[0] === 32 ? "xx" : "nk"));
  return { socket, dials, patterns, drop: () => dials.at(-1)?.close() };
}

function newClient(
  relayUrl: string,
  hostId: string,
  device: { id: string; token: string },
  socket: (url: string, protocols?: string[]) => PortableSocket,
) {
  const route = relayRoute({
    relayUrl,
    hostId,
    credential: async () => device.token,
    socket,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
  let bound: string | null = null;
  const client = new Client({
    monotonic: () => performance.now(),
    deviceId: DeviceId.parse(device.id),
    storage: {
      load: async () => null,
      save: async () => {},
      hostBinding: {
        load: async () => bound,
        save: async (host: string) => {
          bound = host;
        },
      },
    },
    scheduler: {
      set(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    limits: { retryBaseMs: 1, retryCapMs: 1 },
    random: () => 0.5,
    id: randomUUID,
    now: Date.now,
    transport: route.transport,
    credential: route.credential,
  });
  cleanup.push(() => client.close());
  return client;
}

function ready(client: Client, after = 0, attempts = () => 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const state = client.connectionState();
    const timer = setTimeout(() => reject(new Error("Not ready in time")), 15_000);
    const check = () => {
      if (state.getSnapshot() !== "ready" || attempts() <= after) return;
      clearTimeout(timer);
      stop();
      resolve();
    };
    const stop = state.subscribe(check);
    check();
  });
}

async function newDaemon(relayUrl?: string) {
  const relay = relayUrl ? undefined : await startRelay();
  if (relay) cleanup.push(() => relay.close());
  const url = relayUrl ?? relay?.url ?? "";
  const f = await fixture({ relay: { url, keys: keyPair() } });
  cleanup.push(() => f.close());
  const hostId = f.server.relayHostId ?? "";
  const paired = f.store.devices.create("Phone", ["read", "operate"], Date.now());
  return { url, f, hostId, device: { id: paired.device.id, token: paired.token } };
}

it("a new client and a new daemon reconnect with NK, and a dropped NK stream reconnects with NK again", async () => {
  const h = await newDaemon();
  const sockets = recordedSockets();
  const client = newClient(h.url, h.hostId, h.device, sockets.socket);
  const first = ready(client, 0, () => sockets.dials.length);
  await client.start();
  await first;
  for (const round of [1, 2]) {
    // The confirmation's answer, with the next ticket, follows the welcome.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = sockets.dials.length;
    const again = ready(client, before, () => sockets.dials.length);
    sockets.drop();
    await again;
    expect(sockets.patterns()[before], `reconnect ${round}`).toBe("nk");
  }
  expect(sockets.patterns()[0]).toBe("xx");
});

it("an older client (XX, no next ticket) is welcomed by a new daemon as before", async () => {
  const h = await newDaemon();
  const channel = await connectClientViaRelay({
    relayUrl: h.url,
    hostId: h.hostId,
    pinnedFingerprint: h.hostId,
  });
  cleanup.push(() => channel.close());
  await channel.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse(h.device.id),
    token: h.device.token,
  });
  const welcome = await channel.receive();
  expect(welcome).toMatchObject({ type: "welcome", relayHandshakes: ["nk1"] });
  expect(welcome.type === "welcome" && welcome.ticket).toBeFalsy();
});

/** A daemon that never heard of NK: the relay host without it, and a plain welcome. */
async function olderDaemon(announce: boolean) {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    async onClientChannel(channel) {
      const hello = await channel.receive();
      if (hello.type !== "hello") return channel.close();
      channel.authorize();
      if (hello.flowControl?.includes("credit")) channel.flowControl?.();
      await channel.send({
        type: "welcome",
        hostId: HostId.parse("host"),
        protocolVersion: 1,
        headSeq: 0,
        // An older daemon announces nothing; `announce` models one that did before a downgrade.
        ...(announce ? { relayHandshakes: ["nk1"] } : {}),
        ...(announce && hello.nextTicket ? { ticket: { ticket: "ab".repeat(32), ttlMs: 60_000 } } : {}),
      });
      for await (const frame of channel.frames())
        if (!(frame instanceof Uint8Array) && frame.type === "ping") await channel.send({ type: "pong" });
    },
  });
  cleanup.push(() => host.close());
  return { url: relay.url, hostId: host.hostId };
}

it("a new client and an older daemon stay on XX", async () => {
  const h = await olderDaemon(false);
  const sockets = recordedSockets();
  const client = newClient(h.url, h.hostId, { id: "phone", token: "device token" }, sockets.socket);
  const first = ready(client, 0, () => sockets.dials.length);
  await client.start();
  await first;
  const again = ready(client, 1, () => sockets.dials.length);
  sockets.drop();
  await again;
  expect(sockets.patterns()).toEqual(["xx", "xx"]);
});

it("a daemon that announced NK but no longer takes it costs one refused NK first message, then XX in the same attempt", async () => {
  const h = await olderDaemon(true);
  const sockets = recordedSockets();
  const client = newClient(h.url, h.hostId, { id: "phone", token: "device token" }, sockets.socket);
  const first = ready(client, 0, () => sockets.dials.length);
  await client.start();
  await first;
  const again = ready(client, 2, () => sockets.dials.length);
  sockets.drop();
  await again;
  expect(sockets.patterns()).toEqual(["xx", "nk", "xx"]);
});

it("a relay that drops every NK first message forces XX and nothing else: the pin holds and the daemon is reached", async () => {
  const h = await newDaemon();
  // A relay in front of the real one that kills any stream whose first frame isn't 32 bytes.
  const front = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  cleanup.push(() => new Promise((resolve) => front.close(resolve)));
  front.on("connection", (incoming, request) => {
    const protocol = request.headers["sec-websocket-protocol"];
    const upstream = new Ws(
      new URL(request.url ?? "/", h.url).toString(),
      protocol ? protocol.split(",").map((p) => p.trim()) : [],
    );
    const pending: Buffer[] = [];
    let first = true;
    incoming.on("message", (data: Buffer) => {
      if (first) {
        first = false;
        if (data.length !== 32) return incoming.terminate();
      }
      if (upstream.readyState === Ws.OPEN) upstream.send(data);
      else pending.push(data);
    });
    upstream.on("open", () => {
      for (const data of pending.splice(0)) upstream.send(data);
    });
    upstream.on("message", (data: Buffer) => incoming.send(data));
    upstream.on("close", () => incoming.close());
    incoming.on("close", () => upstream.close());
  });
  await new Promise((resolve) => front.once("listening", resolve));
  const address = front.address();
  const frontUrl = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const sockets = recordedSockets();
  const client = newClient(frontUrl, h.hostId, h.device, sockets.socket);
  const first = ready(client, 0, () => sockets.dials.length);
  await client.start();
  await first;
  const again = ready(client, 2, () => sockets.dials.length);
  sockets.drop();
  await again;
  // The NK attempt was dropped; XX reached the same pinned daemon at once.
  expect(sockets.patterns()).toEqual(["xx", "nk", "xx"]);
  expect(client.connectionState().getSnapshot()).toBe("ready");
});
