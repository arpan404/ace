import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { expectedLocalDaemon } from "./expected.ts";

const token = "ab".repeat(32);
const hostId = "0c6b3f5e-2a1d-4f4e-9d55-6f0e2b1c9a77";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A daemon home that has run before: its token and identity, and an endpoint if it runs now. */
async function home(endpoint?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-expected-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "daemon-token"), token);
  await writeFile(join(dir, "host-id"), hostId);
  if (endpoint) await writeFile(join(dir, "daemon-endpoint"), endpoint);
  return dir;
}

async function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

/** A status endpoint that accepts only `accepted` as its host token. */
function statusServer(accepted: string): Server {
  return createHttpServer((request, response) => {
    response.statusCode = request.headers.authorization === `Bearer ${accepted}` ? 200 : 401;
    response.end("{}");
  });
}

/** A port nothing listens on (taken, then released). */
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("a daemon still starting is expected at the address the window was last handed", async () => {
  const port = await closedPort();
  const expected = await expectedLocalDaemon(await home(), `ws://127.0.0.1:${port}/`);
  expect(expected).toEqual({
    origin: `http://127.0.0.1:${port}`,
    url: `ws://127.0.0.1:${port}/`,
    token,
    hostId,
  });
});

test("a running daemon is expected at its endpoint, whatever address the window remembered", async () => {
  const port = await listen(statusServer(token));
  const expected = await expectedLocalDaemon(
    await home(`http://127.0.0.1:${port}`),
    "ws://127.0.0.1:1/",
  );
  expect(expected?.url).toBe(`ws://127.0.0.1:${port}/`);
});

test("another daemon answering at the remembered address is never expected", async () => {
  const port = await listen(statusServer("cd".repeat(32)));
  expect(await expectedLocalDaemon(await home(), `ws://127.0.0.1:${port}/`)).toBeUndefined();
});

test("nothing is expected without a remembered loopback address or the home's token", async () => {
  const port = await closedPort();
  expect(await expectedLocalDaemon(await home(), undefined)).toBeUndefined();
  expect(await expectedLocalDaemon(await home(), `ws://example.com:${port}/`)).toBeUndefined();
  const empty = await mkdtemp(join(tmpdir(), "ace-expected-"));
  cleanups.push(() => rm(empty, { recursive: true, force: true }));
  expect(await expectedLocalDaemon(empty, `ws://127.0.0.1:${port}/`)).toBeUndefined();
});
