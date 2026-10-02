import { afterEach, expect, test } from "vitest";
import { once } from "node:events";
import { request } from "node:http";
import { Readable } from "node:stream";
import { attachPreviewRelay, openPreviewProxy } from "./index.ts";
import { channelPair, serve, http, echoWebsocket, websocket, echo } from "./test-support.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .toReversed()
      .map((f) => f()),
  );
});
function control(kind: number, id: number, value = 0) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, kind);
  view.setUint32(4, id);
  view.setUint32(8, value);
  return data;
}
async function fixture(handler: Parameters<typeof serve>[0], allowed = true) {
  const upstream = await serve(handler);
  cleanup.push(upstream.close);
  const channels = channelPair();
  const host = attachPreviewRelay({
    channel: channels.b,
    allowPort: async (port) => allowed && port === upstream.port,
  });
  cleanup.push(host.close);
  const proxy = await openPreviewProxy({ channel: channels.a, port: upstream.port });
  cleanup.push(proxy.close);
  return { upstream, channels, host, proxy };
}

test("relay multiplexes concurrent HTTP sockets and rewrites Host and Origin", async () => {
  const pending: import("node:http").ServerResponse[] = [];
  const { proxy, upstream } = await fixture((req, res) => {
    pending.push(res);
    if (req.headers.host !== `localhost:${upstream.port}` || req.headers.origin !== upstream.url)
      throw new Error("Wrong upstream origin");
    if (pending.length === 32) for (const response of pending) response.end("over relay");
  });
  const results = await Promise.all(
    Array.from({ length: 32 }, () => http(proxy.url, { origin: proxy.url })),
  );
  expect(results.every((r) => r.status === 200 && r.body === "over relay")).toBe(true);
});

test("relay refuses unapproved ports before connecting to the upstream", async () => {
  let hits = 0;
  const { proxy } = await fixture((_req, res) => {
    hits++;
    res.end("secret");
  }, false);
  expect((await http(proxy.url)).status).toBe(502);
  expect(hits).toBe(0);
});

test("loopback preview rejects cross-origin requests and forged Host values", async () => {
  let hits = 0;
  const { proxy } = await fixture((_req, res) => {
    hits++;
    res.end("secret");
  });
  expect(
    (await http(proxy.url, { host: `evil.test:${Number(new URL(proxy.url).port)}` })).status,
  ).toBe(403);
  expect((await http(proxy.url, { origin: "http://evil.test" })).status).toBe(403);
  expect(hits).toBe(0);
});

test("relay carries an 8 MiB streamed upload and download with bounded socket queues", async () => {
  const size = 8 * 1024 * 1024;
  const { proxy, host } = await fixture((req, res) => req.pipe(res));
  const url = new URL(proxy.url);
  let maxBuffered = 0;
  const incoming = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(proxy.url).port),
        method: "POST",
        headers: { host: url.host },
        agent: false,
      },
      resolve,
    );
    req.once("error", reject);
    Readable.from(
      (async function* () {
        for (let n = 0; n < size; n += 16_384) {
          yield Buffer.alloc(16_384, 9);
          maxBuffered = Math.max(
            maxBuffered,
            proxy.stats().bufferedBytes,
            host.stats().bufferedBytes,
          );
        }
      })(),
    ).pipe(req);
  });
  let received = 0;
  for await (const chunk of incoming) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected streamed bytes");
    expect(chunk.every((b) => b === 9)).toBe(true);
    received += chunk.length;
    maxBuffered = Math.max(maxBuffered, proxy.stats().bufferedBytes, host.stats().bufferedBytes);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(received).toBe(size);
  expect(maxBuffered).toBeLessThan(524_288);
});

test("SSE arrives through the relay before the response is complete", async () => {
  let finish: (() => void) | undefined;
  const { proxy } = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    finish = () => res.end("data: final\n\n");
  });
  const url = new URL(proxy.url);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(proxy.url).port),
        headers: { host: url.host },
        agent: false,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
  const [first] = await once(response, "data");
  expect(String(first)).toBe("data: first\n\n");
  const ended = once(response, "end");
  response.resume();
  finish?.();
  await ended;
});

test("websocket echo reconnects on a replacement channel after relay disconnection", async () => {
  const { proxy, channels, upstream } = await fixture((_req, res) => res.end("ok"));
  const wss = echoWebsocket(upstream.server);
  const ws = await websocket(proxy.url, "");
  expect(await echo(ws, "first channel")).toBe("first channel");
  const disconnected = once(ws, "close");
  channels.disconnect();
  await disconnected;
  await expect(http(proxy.url)).rejects.toThrow();
  const next = channelPair();
  const host = attachPreviewRelay({ channel: next.b, allowPort: async (p) => p === upstream.port });
  cleanup.push(host.close);
  const replacement = await openPreviewProxy({ channel: next.a, port: upstream.port });
  cleanup.push(replacement.close);
  const reconnected = await websocket(replacement.url, "");
  expect(await echo(reconnected, "new channel")).toBe("new channel");
  reconnected.terminate();
  for (const peer of wss.clients) peer.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("malformed relay frames close existing streams instead of accepting unbounded payloads", async () => {
  const { proxy, channels, upstream } = await fixture((_req, res) => res.end());
  const wss = echoWebsocket(upstream.server);
  const ws = await websocket(proxy.url, "");
  expect(await echo(ws, "alive")).toBe("alive");
  const disconnected = once(ws, "close");
  await channels.a.send(new Uint8Array(16_397));
  await disconnected;
  for (const peer of wss.clients) peer.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("pending authorization reserves stream capacity and excess opens reset immediately", async () => {
  const channels = channelPair();
  const replies: Uint8Array[] = [];
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = attachPreviewRelay({
    channel: channels.b,
    maxStreams: 2,
    allowPort: async () => {
      await waiting;
      return false;
    },
  });
  cleanup.push(host.close);
  let gotReset: (() => void) | undefined;
  const reset = new Promise<void>((resolve) => {
    gotReset = resolve;
  });
  channels.a.subscribe(
    (frame) => {
      replies.push(frame);
      if (new DataView(frame.buffer, frame.byteOffset).getUint32(4) === 3) gotReset?.();
    },
    () => {},
  );
  await channels.a.send(control(1, 1, 3000));
  await channels.a.send(control(1, 2, 3000));
  await channels.a.send(control(1, 3, 3000));
  await reset;
  expect(replies[0]?.[1]).toBe(6);
  release?.();
});

test("relay rejects credit inflation and terminates the affected channel", async () => {
  const { proxy, channels, upstream } = await fixture((_req, res) => res.end());
  const wss = echoWebsocket(upstream.server);
  const ws = await websocket(proxy.url, "");
  expect(await echo(ws, "alive")).toBe("alive");
  const disconnected = once(ws, "close");
  await channels.a.send(control(4, 1, 262_145));
  await disconnected;
  for (const peer of wss.clients) peer.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("a blocked relay transport closes under a flood of control responses", async () => {
  let receive: ((bytes: Uint8Array) => void) | undefined;
  let closed = false;
  const pending = new Set<() => void>();
  const host = attachPreviewRelay({
    maxStreams: 1,
    allowPort: async () => false,
    channel: {
      send: async () => new Promise<void>((done) => pending.add(done)),
      close() {
        closed = true;
        for (const done of pending) done();
        pending.clear();
      },
      subscribe(onFrame) {
        receive = onFrame;
        return () => {
          receive = undefined;
        };
      },
    },
  });
  try {
    for (let id = 1; id <= 100; id++) receive?.(control(1, id, 3000));
    await new Promise<void>((done) => setImmediate(done));
    expect(closed).toBe(true);
  } finally {
    host.close();
  }
});
