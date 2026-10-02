import { afterEach, expect, test } from "vitest";
import { request } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { http, serve, gateway, echoWebsocket, websocket, echo } from "./test-support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .toReversed()
      .map((f) => f()),
  );
});

test("Host and Origin are rewritten and loopback redirects keep the preview origin", async () => {
  const upstream = await serve((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://localhost:${upstream.port}/next?q=1#fragment` });
      res.end();
    } else
      res.end(
        JSON.stringify({
          host: req.headers.host,
          origin: req.headers.origin,
          forwarded: req.headers["x-forwarded-host"],
        }),
      );
  });
  cleanup.push(upstream.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  expect(
    JSON.parse((await http(origin, { cookie, origin, "x-forwarded-host": "evil" })).body),
  ).toEqual({ host: `localhost:${upstream.port}`, origin: `http://localhost:${upstream.port}` });
  expect((await http(`${origin}/redirect`, { cookie })).headers.location).toBe(
    `${origin}/next?q=1#fragment`,
  );
});

test("revocation terminates live SSE and blocks new requests", async () => {
  const upstream = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: live\n\n");
  });
  cleanup.push(upstream.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  const url = new URL(origin);
  const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port: g.port, headers: { host: url.host, cookie }, agent: false },
      resolve,
    );
    req.once("error", reject);
    req.end();
  });
  const [chunk] = await once(res, "data");
  expect(String(chunk)).toBe("data: live\n\n");
  const closed = new Promise<void>((resolve) => {
    res.once("close", resolve);
    res.on("error", () => {});
  });
  g.revoke();
  await closed;
  expect((await http(origin, { cookie })).status).toBe(401);
});

test("unregistering closes a preview and a new generation rejects its old session", async () => {
  const upstream = await serve((_req, res) => res.end("ok"));
  cleanup.push(upstream.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  g.unregister(upstream.port);
  const replacement = g.register({ port: upstream.port });
  expect((await http(origin, { cookie })).status).toBe(403);
  expect((await http(replacement, { cookie })).status).toBe(401);
});

test("a 50 MiB download arrives before upstream completion with bounded stream queues", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const size = 50 * 1024 * 1024;
  let maxGatewayQueue = 0;
  const upstream = await serve((_req, res) => {
    const body = Readable.from(
      (async function* () {
        yield Buffer.alloc(65_536, 7);
        await gate;
        for (let offset = 65_536; offset < size; offset += 65_536) yield Buffer.alloc(65_536, 7);
      })(),
    );
    body.pipe(res);
  });
  cleanup.push(upstream.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  const url = new URL(origin);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port: g.port, headers: { host: url.host, cookie }, agent: false },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
  let received = 0,
    maxQueue = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    expect(bytes.every((b) => b === 7)).toBe(true);
    received += bytes.length;
    if (received > 0) release?.();
    maxQueue = Math.max(maxQueue, response.readableLength);
    maxGatewayQueue = Math.max(maxGatewayQueue, g.stats().bufferedBytes);
    await new Promise<void>((done) => setImmediate(done));
  }
  expect(received).toBe(size);
  expect(maxQueue).toBeLessThan(262_144);
  expect(maxGatewayQueue).toBeLessThan(524_288);
});

test("200 concurrent connections all reach the upstream before any finishes", async () => {
  const pending: import("node:http").ServerResponse[] = [];
  const upstream = await serve((_req, res) => {
    pending.push(res);
    if (pending.length === 200) for (const response of pending) response.end("concurrent");
  });
  cleanup.push(upstream.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  const responses = await Promise.all(Array.from({ length: 200 }, () => http(origin, { cookie })));
  expect(responses.every((r) => r.status === 200 && r.body === "concurrent")).toBe(true);
});

test("websocket echo works after an upstream restart that mimics HMR reconnect", async () => {
  const upstream = await serve((_req, res) => res.end());
  const wss = echoWebsocket(upstream.server);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  const ws = await websocket(origin, cookie);
  expect(await echo(ws, "before reload")).toBe("before reload");
  const disconnected = once(ws, "close");
  for (const peer of wss.clients) peer.terminate();
  await disconnected;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await upstream.close();
  const replacement = await serve((_req, res) => res.end(), upstream.port);
  cleanup.push(replacement.close);
  const newWss = echoWebsocket(replacement.server);
  const reconnected = await websocket(origin, cookie);
  expect(await echo(reconnected, "after reload")).toBe("after reload");
  reconnected.terminate();
  for (const peer of newWss.clients) peer.terminate();
  await new Promise<void>((resolve) => newWss.close(() => resolve()));
});

test("uploads stream back to the browser before the request body is complete", async () => {
  const upstream = await serve((req, res) => req.pipe(res));
  cleanup.push(upstream.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  const url = new URL(origin);
  let complete: (() => void) | undefined;
  const req = request({
    hostname: "127.0.0.1",
    port: g.port,
    method: "POST",
    headers: { host: url.host, cookie },
    agent: false,
  });
  const response = once(req, "response");
  req.write("first");
  complete = () => req.end("last");
  const [res] = await response;
  if (!(res instanceof (await import("node:http")).IncomingMessage)) throw new Error("No response");
  const [data] = await once(res, "data");
  expect(String(data)).toBe("first");
  let tail = "";
  res.on("data", (chunk: Buffer) => {
    tail += String(chunk);
  });
  const end = once(res, "end");
  complete();
  await end;
  expect(tail).toBe("last");
});

test("IPv6-only localhost servers work without allowing arbitrary DNS destinations", async () => {
  const upstream = await serve((_req, res) => res.end("IPv6 preview"), 0, "::1");
  cleanup.push(upstream.close);
  const g = await gateway();
  cleanup.push(g.close);
  const origin = g.register({ port: upstream.port });
  const { cookie } = await g.login(upstream.port);
  expect((await http(origin, { cookie })).body).toBe("IPv6 preview");
});
