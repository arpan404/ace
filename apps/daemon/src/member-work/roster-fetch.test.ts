import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { BackendUnreachable } from "./member-work.ts";
import { fetchRoster } from "./roster-fetch.ts";

/*
 * Which roster fetches earn the offline allowance (ADR 0209 §7.1): only no answer at all. Every
 * HTTP answer, a refusal, the origin's own contention, a proxy's 5xx or a redirect, is the
 * backend's word. Against a real local HTTP server.
 */

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function answering(handle: Parameters<typeof createServer>[1]) {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const fetchFrom = (origin: string, timeoutMs?: number) =>
  fetchRoster(fetch, { origin, token: "t" }, "org_01ACME", "A".repeat(52), timeoutMs);

it("an answer of any kind is the backend's word, never no answer", async () => {
  for (const [status, body, headers] of [
    [503, '{"error":"busy"}', { "content-type": "application/json" }],
    [503, '{"error":"roster_epoch_unset"}', { "content-type": "application/json" }],
    [502, "<html>Bad gateway</html>", { "content-type": "text/html" }],
    [401, '{"error":"unauthenticated"}', { "content-type": "application/json" }],
    [302, "", { location: "https://elsewhere.example/" }],
  ] as const) {
    const origin = await answering((_request, response) => {
      response.writeHead(status, headers);
      response.end(body);
    });
    const failure = await fetchFrom(origin).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BackendUnreachable);
  }
});

it("no answer at all, or none in time, is the backend unreachable", async () => {
  const closed = await answering(() => {});
  const port = new URL(closed).port;
  await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
  await expect(fetchFrom(`http://127.0.0.1:${port}`)).rejects.toBeInstanceOf(BackendUnreachable);
  const silent = await answering(() => {});
  await expect(fetchFrom(silent, 200)).rejects.toBeInstanceOf(BackendUnreachable);
});

it("a refusal whose body stalls, or an answer cut short, is still the backend's word", async () => {
  // A 503 whose body never finishes arriving.
  const stalled = await answering((_request, response) => {
    response.writeHead(503, { "content-type": "application/json", "content-length": "100" });
    response.write('{"error":');
  });
  const refused = await fetchFrom(stalled, 300).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
  expect(refused).not.toBeInstanceOf(BackendUnreachable);
  // A 200 whose body is cut off mid-way.
  const cut = await answering((request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    response.write('{"body":');
    setTimeout(() => request.socket.destroy(), 20);
  });
  const truncated = await fetchFrom(cut, 2_000).catch((error: unknown) => error);
  expect(truncated).toBeInstanceOf(Error);
  expect(truncated).not.toBeInstanceOf(BackendUnreachable);
});
