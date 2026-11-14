import { createServer as createHttp } from "node:http";
import { createServer as createTcp, connect as dial, type Socket } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, expect, test } from "vitest";
import { ClientMessage, DeviceId, ThreadView } from "@ace/protocol";
import { pairedSocketCredential } from "./access-ticket.ts";
import { Client, webSocketTransport } from "./index.ts";
import { memoryStorage } from "./test-support.ts";

/*
 * Network flights from "connect" to the first replay frame, on a link with a fixed round trip.
 * A scripted daemon (ticket exchange over HTTP, WebSocket hello, welcome and replay) sits behind
 * a TCP proxy that delays every byte by half a round trip each way and holds a new connection's
 * first bytes for one more round trip, as TCP's handshake does. The connect time divided by the
 * round trip is the number of flights in series. TLS is not modelled: over TLS 1.3 each new
 * connection costs one flight more.
 */

const rttMs = 200;
const hostId = "6f1c2a8e-4b7d-4e2a-9c1f-2d3b4a5c6d7e";
const deviceToken = "d".repeat(64);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Forward `from` to `to`, each chunk arriving no sooner than `earliest` and in order. */
function delayed(from: Socket, to: Socket, earliest: () => number): void {
  let last = 0;
  from.on("data", (chunk) => {
    const at = Math.max(performance.now() + rttMs / 2, earliest(), last);
    last = at;
    setTimeout(() => to.write(chunk), at - performance.now());
  });
  from.on("close", () => setTimeout(() => to.destroy(), rttMs / 2));
  from.on("error", () => {});
}

async function slowLink(port: number) {
  const open = new Set<Socket>();
  const proxy = createTcp((client) => {
    // The client's first bytes leave once the SYN/SYN-ACK round trip is done.
    const opened = performance.now();
    const upstream = dial(port, "127.0.0.1");
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
    }
    delayed(client, upstream, () => opened + rttMs + rttMs / 2);
    delayed(upstream, client, () => 0);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        proxy.close(() => resolve());
      }),
  );
  const address = proxy.address();
  if (typeof address === "string" || !address) throw new Error("No proxy address");
  return address.port;
}

const view = ThreadView.parse({
  kind: "thread",
  seq: 1,
  thread: {
    id: "thread",
    workspaceId: "workspace",
    provider: "codex",
    title: "Replayed",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  },
  agents: {},
  runs: {},
  items: {},
  itemOrder: [],
  interactions: {},
  backgroundTasks: {},
  usage: {},
  usageSnapshots: {},
  agentChildren: {},
});

/** A daemon that exchanges and hands over one-use tickets and replays one thread. */
async function scriptedDaemon() {
  const tickets = new Set<string>();
  let issued = 0;
  let exchanges = 0;
  const mint = () => {
    const ticket = (++issued).toString(16).padStart(64, "0");
    tickets.add(ticket);
    return ticket;
  };
  const http = createHttp((request, response) => {
    if (request.url !== "/v1/tickets" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    exchanges++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ticket: mint(), expiresAt: Date.now() + 60_000 }));
  });
  const sockets = new WebSocketServer({ server: http });
  const open = new Set<import("ws").WebSocket>();
  sockets.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("message", (data) => {
      for (const line of data.toString().split("\n")) {
        const message = ClientMessage.parse(JSON.parse(line));
        if (message.type === "hello") {
          if (!message.ticket || !tickets.delete(message.ticket)) {
            socket.send(JSON.stringify({ type: "error", code: "unauthorized", message: "No" }));
            socket.close(4001, "unauthorized");
            return;
          }
          socket.send(
            JSON.stringify({
              type: "welcome",
              hostId,
              protocolVersion: 1,
              headSeq: 1,
              databaseId: "db",
              ...(message.nextTicket ? { ticket: { ticket: mint(), ttlMs: 60_000 } } : {}),
            }),
          );
        } else if (message.type === "subscribe" && message.scope.kind === "thread") {
          const id = message.subscriptionId;
          socket.send(JSON.stringify({ type: "snapshot", subscriptionId: id, seq: 1, view }));
          socket.send(JSON.stringify({ type: "subscription.ready", subscriptionId: id, seq: 1 }));
        } else if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of open) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (typeof address === "string" || !address) throw new Error("No daemon address");
  return {
    port: address.port,
    exchanges: () => exchanges,
    dropAll: () => {
      for (const socket of open) socket.terminate();
    },
  };
}

async function pairedClient(port: number) {
  const url = `ws://127.0.0.1:${port}`;
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: () => webSocketTransport(() => new WebSocket(url)),
    credential: pairedSocketCredential({
      url,
      token: async () => deviceToken,
      fetch: (input, init) => fetch(input, init),
    }),
    storage: memoryStorage(),
    scheduler: {
      set(delay, run) {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0,
    id: () => `id-${++sequence}`,
    now: () => Date.now(),
    limits: { retryBaseMs: 1, retryCapMs: 1 },
  });
  cleanups.push(() => client.close());
  return client;
}

/** Flights from `since` until the thread shows its replay. */
async function flightsUntilReplay(store: { thread: unknown }, since: number): Promise<number> {
  while (!store.thread) await new Promise((resolve) => setTimeout(resolve, 2));
  return Math.round((performance.now() - since) / rttMs);
}

test("a paired device's first connect reaches its first replay in three flights", async () => {
  const daemon = await scriptedDaemon();
  const client = await pairedClient(await slowLink(daemon.port));
  const thread = client.thread("thread");
  const since = performance.now();
  await client.start();
  // The socket (TCP, upgrade) and the ticket exchange (TCP, POST) overlap; the hello and the
  // subscribe share a flight. Before: 2 + 2 + 1 + 1 = 6.
  expect(await flightsUntilReplay(thread.store, since)).toBe(3);
  expect(daemon.exchanges()).toBe(1);
  thread.release();
});

test("a reconnect with the welcome's ticket skips the exchange", async () => {
  const daemon = await scriptedDaemon();
  const client = await pairedClient(await slowLink(daemon.port));
  const first = client.thread("thread");
  await client.start();
  await flightsUntilReplay(first.store, performance.now());
  first.release();
  await client.forgetThread("thread");
  const thread = client.thread("thread");
  expect(thread.store.thread).toBeUndefined();
  // The drop reaches the client half a round trip after the daemon cuts the socket.
  const since = performance.now() + rttMs / 2;
  daemon.dropAll();
  // TCP, upgrade, then hello and subscribe: no ticket exchange at all.
  expect(await flightsUntilReplay(thread.store, since)).toBe(3);
  expect(daemon.exchanges()).toBe(1);
  thread.release();
});
