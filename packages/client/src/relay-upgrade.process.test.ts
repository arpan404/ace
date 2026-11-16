import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { DeviceId } from "@ace/protocol";
import { connectHostToRelay, startRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { connectPortableRelay, type PortableSocket } from "./portable-relay.ts";
import { RELAY_EARLY, relayRoute } from "./relay-route.ts";

// The client's first handshake message in its upgrade request (ADR 0155, step 3), against the
// real self-hosted relay and the daemon's own relay host, which is unchanged: a new relay takes
// it and the daemon's answer follows the upgrade answer; a relay that doesn't know it gets the
// message as step 1 sends it; a proxy that refuses the header costs one retry without it.

const disposals: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose();
});

/**
 * A proxy in front of the relay. `filter` rewrites the offered subprotocols (an older relay
 * ignores what it doesn't know); `refuse` turns an upgrade away before it opens (a proxy with a
 * header limit). The proxy echoes what the relay behind it chose.
 */
async function proxy(
  target: string,
  options: { filter?: (offered: string[]) => string[]; refuse?: (header: string) => boolean },
) {
  /** What the relay behind chose for each upgrade, echoed to the client. */
  const chosen = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (_protocols, request) => chosen.get(request) || false,
  });
  const server = createServer();
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const header = request.headers["sec-websocket-protocol"] ?? "";
    if (options.refuse?.(header)) {
      socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
      return;
    }
    const offered = header ? header.split(",").map((entry) => entry.trim()) : [];
    const upstream = new WebSocket(
      new URL(request.url ?? "/", target).toString(),
      options.filter?.(offered) ?? offered,
    );
    upstream.on("error", () => socket.destroy());
    upstream.on("open", () => {
      chosen.set(request, upstream.protocol);
      wss.handleUpgrade(request, socket, head, (client) => {
        client.on("message", (data: Buffer) => upstream.send(data));
        upstream.on("message", (data: Buffer) => client.send(data));
        client.on("close", () => upstream.close());
        upstream.on("close", () => client.close());
        client.on("error", () => upstream.terminate());
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  disposals.push(() => new Promise((resolve) => server.close(resolve)));
  disposals.push(() => wss.close());
  const address = server.address();
  return `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

async function relayAndHost() {
  const relay = await startRelay();
  disposals.push(() => relay.close());
  let arrived = Promise.withResolvers<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: (channel) => arrived.resolve(channel),
  });
  disposals.push(() => host.close());
  /** One connection, with every frame the client sends and receives in order. */
  const connect = async (relayUrl = relay.url) => {
    arrived = Promise.withResolvers<HostChannel>();
    const order: string[] = [];
    const offered: string[][] = [];
    let echoed = "";
    const socket = (url: string, protocols?: string[]): PortableSocket => {
      offered.push(protocols ?? []);
      const real = new WebSocket(url, protocols);
      real.on("open", () => (echoed = real.protocol));
      real.on("message", () => order.push("received"));
      const send = real.send.bind(real);
      return Object.assign(real, {
        send(data: string | Uint8Array) {
          order.push("sent");
          send(data);
        },
      }) as unknown as PortableSocket;
    };
    const client = await connectPortableRelay({
      relayUrl,
      pinnedFingerprint: host.hostId,
      socket,
      keys: () => ({ staticKey: keyPair(), ephemeralKey: keyPair() }),
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      early: true,
      inUpgrade: true,
    });
    disposals.push(() => client.close());
    const server = await arrived.promise;
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("phone"),
      token: "device token",
    });
    expect(await server.receive()).toMatchObject({ type: "hello" });
    return { client, order, offered, echoed: () => echoed };
  };
  return { relay, host, connect };
}

it("a new client and a new relay: the first message goes in the upgrade and is never sent as a frame", async () => {
  const h = await relayAndHost();
  const { order, offered, echoed } = await h.connect();
  expect(offered[0]).toContain(RELAY_EARLY.inUpgrade);
  expect(echoed()).toBe(RELAY_EARLY.inUpgrade);
  // The marker and the daemon's answer come first: nothing was sent before them.
  expect(order.slice(0, 3)).toEqual(["received", "received", "sent"]);
});

it("a new client and a relay that only knows step 1: the message goes as an early frame instead", async () => {
  const h = await relayAndHost();
  const older = await proxy(h.relay.url, {
    filter: (offered) =>
      offered.filter(
        (entry) => entry !== RELAY_EARLY.inUpgrade && !entry.startsWith(RELAY_EARLY.messagePrefix),
      ),
  });
  const { order, echoed } = await h.connect(older);
  expect(echoed()).toBe(RELAY_EARLY.subprotocol);
  expect(order.slice(0, 3)).toEqual(["sent", "received", "received"]);
});

it("a proxy that refuses the larger header costs one dial: the route retries at once without it and connects", async () => {
  const h = await relayAndHost();
  const limited = await proxy(h.relay.url, {
    refuse: (header) => header.includes(RELAY_EARLY.messagePrefix),
  });
  const offered: string[][] = [];
  const route = relayRoute({
    relayUrl: limited,
    hostId: h.host.hostId,
    credential: async () => ({ grant: "grant" }),
    socket: (url, protocols) => {
      offered.push(protocols ?? []);
      return new WebSocket(url, protocols) as unknown as PortableSocket;
    },
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  });
  const transport = route.transport();
  disposals.push(() => transport.close());
  await new Promise<void>((resolve, reject) =>
    transport.open({
      open: resolve,
      message: () => {},
      close: (code) => reject(new Error(`closed ${code}`)),
    }),
  );
  expect(offered).toHaveLength(2);
  expect(offered[0]).toContain(RELAY_EARLY.inUpgrade);
  expect(offered[1]).not.toContain(RELAY_EARLY.inUpgrade);
});
