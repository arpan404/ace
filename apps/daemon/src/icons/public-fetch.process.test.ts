import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { isPublicAddress, publicGet } from "./public-fetch.ts";
import { localSite } from "./local-site.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

test("loopback, private, link-local, shared, multicast and mapped addresses are not public", () => {
  for (const address of [
    "127.0.0.1",
    "10.2.3.4",
    "172.20.0.1",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "not an address",
  ])
    expect([address, isPublicAddress(address)]).toEqual([address, false]);
  for (const address of ["1.1.1.1", "140.82.112.3", "2606:4700:4700::1111"])
    expect([address, isPublicAddress(address)]).toEqual([address, true]);
});

// Mutation: trusting a host name without checking what it resolves to.
test("a host name that resolves to a private address is refused before connecting", async () => {
  const reply = await publicGet("https://intranet.example/favicon.ico", {
    resolve: async () => ["93.184.216.34", "10.0.0.5"],
    timeoutMs: 500,
  });
  expect(reply).toEqual({ kind: "refused" });
});

// Mutation: following redirects without checking each hop.
test("a redirect to a loopback or private address is refused, and never reached", async () => {
  const inside = await localSite({ "/secret": Buffer.from("secret") });
  const outside = await localSite({ "/favicon.ico": { redirect: `${inside.origin}/secret` } });
  closers.push(inside.close, outside.close);
  const reply = await publicGet(`${outside.origin}/favicon.ico`, {
    allowed: outside.allowed,
    timeoutMs: 500,
  });
  expect(reply).toEqual({ kind: "refused" });
  expect(inside.seen).toHaveLength(0);
});

test("redirects within the public web are followed up to a cap", async () => {
  const s = await localSite({
    "/a": { redirect: "/b" },
    "/b": { redirect: "/c" },
    "/c": Buffer.from("icon"),
    "/loop": { redirect: "/loop" },
  });
  closers.push(s.close);
  const reply = await publicGet(`${s.origin}/a`, { allowed: s.allowed, timeoutMs: 500 });
  expect(reply.kind === "ok" && reply.body.toString()).toBe("icon");
  expect(await publicGet(`${s.origin}/loop`, { allowed: s.allowed, timeoutMs: 500 })).toEqual({
    kind: "missing",
  });
});

// Mutation: checking the deadline only between hops, so a dripping site holds a slot for good.
test("a site that drips its bytes slowly is cut off at the fetch's deadline", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "image/png");
    const drip = setInterval(() => response.write("x"), 50);
    response.on("close", () => clearInterval(drip));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const started = performance.now();
  const reply = await publicGet(`http://127.0.0.1:${port}/favicon.ico`, {
    allowed: (host, candidate) => host === "127.0.0.1" && candidate === port,
    timeoutMs: 200,
    maxRedirects: 0,
    maxBytes: 1024 * 1024,
  });
  expect(reply).toEqual({ kind: "failed" });
  // The 200ms idle timeout never fires on a dripping socket; the deadline still ends it.
  expect(performance.now() - started).toBeLessThan(2000);
});
