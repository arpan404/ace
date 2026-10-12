import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { fetchFavicon } from "./favicon-fetch.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A real local site; `routes` maps paths to bodies, anything else is a 404. */
async function site(routes: Record<string, Buffer | "hang">) {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url ?? "", headers: request.headers });
    const body = routes[request.url ?? ""];
    if (body === "hang") return;
    if (!body) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "image/png");
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen };
}

const options = { fetch: globalThis.fetch, timeoutMs: 500 };

// Mutations: skipping the provider's URL, or never falling back to /favicon.ico.
test("the provider's favicon URL is tried first, then the origin's favicon.ico", async () => {
  const s = await site({ "/favicon.ico": Buffer.from("ico") });
  const bytes = await fetchFavicon(
    { kind: "site", origin: s.origin, favicon: `${s.origin}/static/icon.png` },
    options,
  );
  expect(bytes?.toString()).toBe("ico");
  expect(s.seen.map((request) => request.path)).toEqual(["/static/icon.png", "/favicon.ico"]);
  // Public requests only: nothing that identifies the person goes with them.
  for (const request of s.seen) {
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
  }
});

// Mutation: reading an unbounded body.
test("a favicon past the byte cap is refused, and a site without one has none", async () => {
  const s = await site({ "/favicon.ico": Buffer.alloc(4096, 1) });
  expect(
    await fetchFavicon({ kind: "site", origin: s.origin }, { ...options, maxBytes: 1024 }),
  ).toBeNull();
  const empty = await site({});
  expect(await fetchFavicon({ kind: "site", origin: empty.origin }, options)).toBeNull();
});

// Mutation: waiting forever on a site that never answers, or remembering it as having none.
test("a site that does not answer in time may be asked again later", async () => {
  const s = await site({ "/favicon.ico": "hang" });
  expect(await fetchFavicon({ kind: "site", origin: s.origin }, options)).toBeUndefined();
});
