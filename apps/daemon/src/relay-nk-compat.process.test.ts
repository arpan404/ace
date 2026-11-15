import { afterEach, expect, it } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket as Ws } from "ws";
import { DeviceId, HostId } from "@ace/protocol";
import { newClient as openClient, ready, recordedSockets } from "./relay-nk-test-support.ts";
import { connectClientViaRelay, connectHostToRelay, startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { fixture } from "./socket-test-support.ts";

// Old and new clients and daemons over the self-hosted relay (ADR 0155, step 2): each pair
// connects, NK is used only when both ends take it, and a relay can force XX but nothing else.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

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
  const client = openClient(cleanup, h.url, h.hostId, h.device, sockets.socket);
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
    // Its first message went in the upgrade request, and the relay took it.
    expect(sockets.dials[before]?.protocol).toBe("ace.v3");
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
        ...(announce && hello.nextTicket
          ? { ticket: { ticket: "ab".repeat(32), ttlMs: 60_000 } }
          : {}),
      });
      for await (const frame of channel.frames())
        if (!(frame instanceof Uint8Array) && frame.type === "ping")
          await channel.send({ type: "pong" });
    },
  });
  cleanup.push(() => host.close());
  return { url: relay.url, hostId: host.hostId };
}

it("a new client and an older daemon stay on XX", async () => {
  const h = await olderDaemon(false);
  const sockets = recordedSockets();
  const client = openClient(
    cleanup,
    h.url,
    h.hostId,
    { id: "phone", token: "device token" },
    sockets.socket,
  );
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
  const client = openClient(
    cleanup,
    h.url,
    h.hostId,
    { id: "phone", token: "device token" },
    sockets.socket,
  );
  const first = ready(client, 0, () => sockets.dials.length);
  await client.start();
  await first;
  const again = ready(client, 2, () => sockets.dials.length);
  sockets.drop();
  await again;
  expect(sockets.patterns()).toEqual(["xx", "nk", "xx"]);
});

/**
 * A hostile relay in front of the real one: it strips the upgrade entries `strip` names and kills
 * any stream whose first frame is NK-sized (longer than XX's last message). It echoes what the
 * relay behind chose, as a relay must.
 */
async function hostileFront(
  target: string,
  strip: (entry: string) => boolean,
  dropNk = true,
  /** For a stream the relay behind took NK for: cut it after this many frames to the client. */
  cutNkAfter?: number,
) {
  const chosen = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (_protocols, request) => chosen.get(request) || false,
  });
  const server = createServer();
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const header = request.headers["sec-websocket-protocol"] ?? "";
    const offered = header ? header.split(",").map((entry) => entry.trim()) : [];
    const upstream = new Ws(
      new URL(request.url ?? "/", target).toString(),
      offered.filter((entry) => !strip(entry)),
    );
    upstream.on("error", () => socket.destroy());
    upstream.on("open", () => {
      chosen.set(request, upstream.protocol);
      wss.handleUpgrade(request, socket, head, (incoming) => {
        let first = true;
        incoming.on("message", (data: Buffer) => {
          if (first) {
            first = false;
            if (dropNk && data.length > 100) return incoming.terminate();
          }
          upstream.send(data);
        });
        let toClient = 0;
        upstream.on("message", (data: Buffer) => {
          if (cutNkAfter !== undefined && upstream.protocol === "ace.v3" && toClient >= cutNkAfter)
            return incoming.terminate();
          toClient++;
          incoming.send(data);
        });
        upstream.on("close", () => incoming.close());
        incoming.on("close", () => upstream.close());
        incoming.on("error", () => upstream.terminate());
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  cleanup.push(() => wss.close());
  const address = server.address();
  return `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

const isNkEntry = (entry: string) => entry === "ace.v3" || entry.startsWith("ace.n1.");
const isUpgradeEntry = (entry: string) =>
  isNkEntry(entry) || entry === "ace.v2" || entry.startsWith("ace.x1.");

it.each([
  ["strips the NK upgrade entry", isNkEntry, ["xx", "xx"], 1],
  ["strips both upgrade entries and drops NK first frames", isUpgradeEntry, ["xx", "nk", "xx"], 2],
] as const)(
  "a relay that %s forces XX and nothing else: the pin holds and the daemon is reached",
  async (_name, strip, patterns, reconnectDials) => {
    const h = await newDaemon();
    const front = await hostileFront(h.url, strip);
    const sockets = recordedSockets();
    const client = openClient(cleanup, front, h.hostId, h.device, sockets.socket);
    const first = ready(client, 0, () => sockets.dials.length);
    await client.start();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const again = ready(client, reconnectDials, () => sockets.dials.length);
    sockets.drop();
    await again;
    // NK never ran: XX reached the same pinned daemon, at once.
    expect(sockets.dials.at(-1)?.protocol).not.toBe("ace.v3");
    expect(sockets.patterns()).toEqual(patterns);
    expect(client.connectionState().getSnapshot()).toBe("ready");
  },
);

it("a relay that knows step 1 but not the upgrade entries gets the NK first message as its early frame", async () => {
  const h = await newDaemon();
  const front = await hostileFront(h.url, isUpgradeEntry, false);
  const sockets = recordedSockets();
  const client = openClient(cleanup, front, h.hostId, h.device, sockets.socket);
  const first = ready(client, 0, () => sockets.dials.length);
  await client.start();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const again = ready(client, 1, () => sockets.dials.length);
  sockets.drop();
  await again;
  expect(sockets.patterns()).toEqual(["xx", "nk"]);
  expect(sockets.dials[1]?.protocol).toBe("ace.early.1");
});

it("an NK stream cut after the daemon's answer and before its welcome is followed at once by XX, in the same attempt", async () => {
  const h = await newDaemon();
  // The marker and the NK answer get through; the stream is cut before the welcome.
  const front = await hostileFront(h.url, () => false, false, 2);
  const sockets = recordedSockets();
  let attempts = 0;
  const client = openClient(cleanup, front, h.hostId, h.device, sockets.socket, () => attempts++);
  const first = ready(client, 0, () => sockets.dials.length);
  await client.start();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const before = attempts;
  const again = ready(client, 2, () => sockets.dials.length);
  sockets.drop();
  await again;
  expect(sockets.patterns()).toEqual(["xx", "nk", "xx"]);
  // One new attempt after the drop: the XX dial followed the cut NK stream inside it, not after
  // the connection reported a disconnect and started another.
  expect(attempts - before).toBe(1);
});
