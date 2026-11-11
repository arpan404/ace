import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { SpadeLiveEvent } from "../../shared/spade.ts";
import { spadeDirect } from "./direct.ts";
import { spadeEndpointWatch } from "./endpoint-watch.ts";

/** A stand-in Spade on loopback that answers with `handler` and checks the bearer. */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fakeSpade(
  token: string,
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
) {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      if (request.url !== "/health" && request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/** An ACE_HOME with the daemon's `host-id`, and Spade's folder with its two files once published. */
function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), "spade-direct-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "spade"));
  writeFileSync(join(dir, "host-id"), hostId);
  const publish = (port: number, token: string, api = 1) => {
    writeFileSync(join(dir, "spade", "token"), `${token}\n`);
    writeFileSync(
      join(dir, "spade", "server.json"),
      JSON.stringify({ address: `127.0.0.1:${port}`, pid: 1, version: "0.4.0", api }),
    );
  };
  return { dir, publish };
}

/** The direct path over a folder nobody watches, so every change is read on the next ask. */
function direct(dir: string) {
  let clock = 0;
  const watch = spadeEndpointWatch({
    home: dir,
    readText: (path) => readFile(path, "utf8").catch(() => undefined),
    watch: () => undefined,
    now: () => (clock += 10_000),
    onChange: () => {},
  });
  return spadeDirect(watch);
}

const hostId = "0b8d2c1e-5a8f-4d2e-9c7a-3f1e2d4c5b6a";
const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);

test("a request reaches Spade with its token, and the page sees only the answer", async () => {
  const port = await fakeSpade(tokenA, (request, response, body) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, url: request.url, body }));
  });
  const { dir, publish } = dataDir();
  publish(port, tokenA);
  const spade = direct(dir);
  const answer = await spade.request({
    method: "POST",
    path: "/v1/conversations",
    body: '{"text":"hi"}',
  });
  expect(answer).toEqual({
    kind: "text",
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ method: "POST", url: "/v1/conversations", body: '{"text":"hi"}' }),
  });
  expect(await spade.endpoint()).toEqual({
    address: `127.0.0.1:${port}`,
    version: "0.4.0",
    api: 1,
    hostId,
  });
});

test("an image comes back as bytes", async () => {
  const port = await fakeSpade(tokenA, (_request, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from([137, 80, 78, 71]));
  });
  const { dir, publish } = dataDir();
  publish(port, tokenA);
  const answer = await direct(dir).request({ method: "GET", path: "/v1/images/abc" });
  expect(answer.kind).toBe("bytes");
  expect(answer.kind === "bytes" && [...answer.body]).toEqual([137, 80, 78, 71]);
});

test("a Spade that restarted with a new token is asked again with the new one", async () => {
  const { dir, publish } = dataDir();
  const port = await fakeSpade(tokenB, (_request, response) => response.writeHead(204).end());
  publish(port, tokenA);
  let clock = 0;
  const watch = spadeEndpointWatch({
    home: dir,
    readText: (path) => readFile(path, "utf8").catch(() => undefined),
    watch: () => undefined,
    now: () => clock,
    onChange: () => {},
  });
  const spade = spadeDirect(watch);
  await watch.current();
  // The restart rewrote the token while the old reading still held.
  publish(port, tokenB);
  clock += 1;
  expect(await spade.request({ method: "DELETE", path: "/v1/ace" })).toMatchObject({
    kind: "text",
    status: 204,
  });
});

test("with nothing listening, the request is unreachable and safe to send another way", async () => {
  const port = await fakeSpade(tokenA, () => {});
  // Spade stopped: its port is free again, and its files are still there.
  cleanups.splice(0).forEach((cleanup) => cleanup());
  const { dir, publish } = dataDir();
  publish(port, tokenA);
  expect(await direct(dir).request({ method: "GET", path: "/v1/conversations" })).toEqual({
    kind: "unreachable",
  });
  expect(await direct(dir).health()).toBeNull();
});

test("without Spade's files, or for an API this build doesn't speak, there is no endpoint", async () => {
  const { dir, publish } = dataDir();
  expect(await direct(dir).endpoint()).toBeNull();
  publish(4100, tokenA, 99);
  expect(await direct(dir).endpoint()).toBeNull();
  expect(await direct(dir).request({ method: "GET", path: "/v1/models" })).toEqual({
    kind: "unreachable",
  });
});

test("paths outside Spade's API are refused before anything is sent", async () => {
  let asked = 0;
  const port = await fakeSpade(tokenA, (_request, response) => {
    asked++;
    response.end();
  });
  const { dir, publish } = dataDir();
  publish(port, tokenA);
  const spade = direct(dir);
  for (const path of ["/health", "/v1/../maintenance", "/v1/a%2fb"])
    expect(await spade.request({ method: "GET", path })).toMatchObject({
      kind: "error",
      code: "invalid_path",
    });
  expect(asked).toBe(0);
});

test("health reports Spade's version and API without the daemon", async () => {
  const port = await fakeSpade(tokenA, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, version: "0.4.0", api: 1 }));
  });
  const { dir, publish } = dataDir();
  publish(port, tokenA);
  expect(await direct(dir).health()).toEqual({ version: "0.4.0", api: 1 });
});

test("a live stream delivers Spade's events and then one end", async () => {
  const port = await fakeSpade(tokenA, (request, response) => {
    expect(request.url).toBe("/v1/conversations/c1/live?after=3");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: stored\ndata: {"seq":4}\n\n');
    response.end('event: caught_up\ndata: {"seq":4}\n\n');
  });
  const { dir, publish } = dataDir();
  publish(port, tokenA);
  const events: SpadeLiveEvent[] = [];
  const ended = new Promise<void>((resolve) =>
    direct(dir).openLive(
      1,
      { streamId: "s1", path: "/v1/conversations/c1/live?after=3" },
      (event) => {
        events.push(event);
        if (event.kind === "ended") resolve();
      },
    ),
  );
  await ended;
  expect(events).toEqual([
    { streamId: "s1", kind: "frame", event: "stored", data: '{"seq":4}' },
    { streamId: "s1", kind: "frame", event: "caught_up", data: '{"seq":4}' },
    { streamId: "s1", kind: "ended", reason: "closed" },
  ]);
});

test("a live stream with no Spade listening ends unreachable", async () => {
  const { dir } = dataDir();
  const event = await new Promise<SpadeLiveEvent>((resolve) =>
    direct(dir).openLive(1, { streamId: "s1", path: "/v1/conversations/c1/live?after=0" }, resolve),
  );
  expect(event).toEqual({ streamId: "s1", kind: "ended", reason: "unreachable" });
});
