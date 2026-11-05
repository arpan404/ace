import { once } from "node:events";
import { get } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { sniListener, type SniLimits } from "./sni-listener.ts";
import { loadIdentity } from "./tls-identity.ts";

// Real TLS sockets: the deadlines and close behaviour live in Node's and Bun's socket layers.
const identity = loadIdentity(tlsFixtureHome());
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const minute = 60_000;

/** A listener answering 204, with WebSocket upgrades on `/`, bound to 127.0.0.1. */
async function start(limits: Partial<SniLimits>) {
  const errors: Error[] = [];
  const listener = sniListener({
    tls: identity,
    requests: (_request, response) => response.writeHead(204).end(),
    delay: systemDeliveryRuntime.delay,
    log: (error) => errors.push(error),
    limits,
  });
  const wss = new WebSocketServer({ noServer: true });
  listener.http.on("upgrade", (request, socket, head) =>
    wss.handleUpgrade(request, socket, head, (ws) => ws.send("welcome")),
  );
  const port = await listener.listen("127.0.0.1", 0);
  let closed = false;
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    if (!closed) await listener.close();
    wss.close();
  });
  return {
    port,
    wss,
    errors,
    close: async () => {
      closed = true;
      await listener.close();
    },
  };
}

const track = <T extends Socket>(socket: T): T => {
  socket.on("error", () => {});
  cleanups.push(() => void socket.destroy());
  return socket;
};

/** Settles with how long `socket` took to close, or `undefined` if still open after `within`. */
const closesWithin = (socket: Socket, within: number) => {
  const started = Date.now();
  return Promise.race([
    once(socket, "close").then(() => Date.now() - started),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), within)),
  ]);
};

const tlsClient = async (port: number): Promise<TLSSocket> => {
  const socket = track(connectTls({ host: "127.0.0.1", port, rejectUnauthorized: false }));
  await once(socket, "secureConnect");
  return socket;
};

const status = (port: number) =>
  new Promise<number>((resolve, reject) => {
    get({ host: "127.0.0.1", port, rejectUnauthorized: false, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on("error", reject);
  });

/** A keep-alive connection that has had one response and now sits idle. */
async function idleKeepAlive(port: number): Promise<TLSSocket> {
  const socket = await tlsClient(port);
  socket.write("GET / HTTP/1.1\r\nHost: studio\r\n\r\n");
  const [chunk] = await once(socket, "data");
  expect(String(chunk)).toMatch(/^HTTP\/1\.1 204/);
  return socket;
}

async function openWebSocket(port: number) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/`, { rejectUnauthorized: false });
  ws.on("error", () => {});
  cleanups.push(() => ws.terminate());
  await once(ws, "message");
  return ws;
}

test("a client that stalls in the TLS handshake is disconnected, and the listener keeps serving", async () => {
  const listener = await start({ handshake: 200, headers: minute, keepAlive: minute });
  const stalled = track(connectTcp(listener.port, "127.0.0.1"));
  await once(stalled, "connect");

  expect(await closesWithin(stalled, 3000)).toBeDefined();
  expect(await status(listener.port)).toBe(204);
  await listener.close();
});

test("a client that finishes the handshake but never sends a request is disconnected", async () => {
  const listener = await start({ handshake: minute, headers: 200, keepAlive: minute });
  const silent = await tlsClient(listener.port);

  expect(await closesWithin(silent, 3000)).toBeDefined();
  expect(await status(listener.port)).toBe(204);
});

test("an idle keep-alive connection is closed after its keep-alive limit", async () => {
  const listener = await start({ handshake: minute, headers: minute, keepAlive: 200 });
  const idle = await idleKeepAlive(listener.port);

  expect(await closesWithin(idle, 3000)).toBeDefined();
});

test("a WebSocket is not cut off by the request deadlines", async () => {
  const listener = await start({ handshake: 200, headers: 200, keepAlive: 200 });
  const ws = await openWebSocket(listener.port);

  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(ws.readyState).toBe(WebSocket.OPEN);
});

test("closing drops waiting and idle connections at once and leaves WebSockets to their server", async () => {
  const listener = await start({ handshake: minute, headers: minute, keepAlive: minute });
  const silentTcp = track(connectTcp(listener.port, "127.0.0.1"));
  await once(silentTcp, "connect");
  const idle = await idleKeepAlive(listener.port);
  const ws = await openWebSocket(listener.port);

  const dropped = [closesWithin(silentTcp, 1000), closesWithin(idle, 1000)];
  const started = Date.now();
  await listener.close();
  expect(Date.now() - started).toBeLessThan(500);
  for (const elapsed of await Promise.all(dropped)) expect(elapsed).toBeDefined();

  // The WebSocket server still owns its socket, so clients get its close code, not 1006.
  expect(ws.readyState).toBe(WebSocket.OPEN);
  const closed = once(ws, "close");
  for (const client of listener.wss.clients) client.close(1001, "Daemon shutdown");
  const [code] = await closed;
  expect(code).toBe(1001);

  // The port is free again.
  const again = sniListener({
    tls: identity,
    requests: (_request, response) => response.writeHead(204).end(),
    delay: systemDeliveryRuntime.delay,
    log: () => {},
  });
  expect(await again.listen("127.0.0.1", listener.port)).toBe(listener.port);
  await again.close();
  expect(listener.errors).toEqual([]);
});
