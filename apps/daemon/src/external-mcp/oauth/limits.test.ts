import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { grantDatabase } from "../grant-test-support.ts";
import { OutsideAccess } from "../outside.ts";
import { abandonedAfterMs, pendingLimits } from "./authorize.ts";
import { outsideBase, type OutsideBase } from "./base.ts";
import type { MetadataFetch } from "./cimd.ts";
import { outsideOAuth } from "./service.ts";
import { callLimits } from "./surface.ts";

/** The MCP endpoint itself is out of scope here. */
const mcp = async () => new Response(null, { status: 418 });
/** Every client is a metadata document naming one web redirect. */
const fetchMetadata: MetadataFetch = async (url) => ({
  status: 200,
  headers: new Headers(),
  body: new TextEncoder().encode(
    JSON.stringify({
      client_id: url.href,
      client_name: "App",
      redirect_uris: ["https://app.example/cb"],
    }),
  ),
});
// The sign-in surface as one way in serves it, on a database in memory and a clock and timers
// the test moves. Clients are metadata documents served by the fake fetch.
function surface() {
  const { sql } = grantDatabase();
  const clock = { now: 1_000_000 };
  const timers: { at: number; run: () => void }[] = [];
  const after = (ms: number, run: () => void) => {
    const timer = { at: clock.now + ms, run };
    timers.push(timer);
    return () => void timers.splice(timers.indexOf(timer), 1);
  };
  const advance = (ms: number) => {
    clock.now += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= clock.now);
      if (!due.length) return;
      for (const timer of due) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    }
  };
  let next = 0;
  const outside = new OutsideAccess({
    sql,
    now: () => clock.now,
    id: () => `id-${++next}`,
    scheduler: { after },
    ended: () => {},
    closeBrowser: () => {},
  });
  const serve = outsideOAuth({
    outside,
    sql,
    now: () => clock.now,
    random: randomBytes,
    after,
    fetchMetadata,
    machine: () => "Studio",
  });
  const call = (base: OutsideBase, path: string, init?: RequestInit, peer?: string) =>
    serve(new Request(`${base.url}${path}`, init), base, mcp, peer);
  const authorize = (base: OutsideBase, client: string, peer?: string) =>
    call(
      base,
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client,
        redirect_uri: "https://app.example/cb",
        code_challenge: createHash("sha256").update("v").digest("base64url"),
        code_challenge_method: "S256",
        resource: `${base.url}/mcp`,
      })}`,
      undefined,
      peer,
    );
  return { outside, advance, call, authorize };
}
const relay = outsideBase("relay", "https://relay.example/m/host-1");
const local = outsideBase("local", "http://127.0.0.1:4100");
const client = (n: number) => `https://app${n}.example/meta.json`;
const waits = (response: Response) =>
  response.status === 303 && (response.headers.get("location") ?? "").includes("/authorize/wait");

test("one client can keep only a few sign-ins waiting at once", async () => {
  const f = surface();
  for (let i = 0; i < pendingLimits.perClient; i++)
    expect(waits(await f.authorize(relay, client(1)))).toBe(true);
  const refused = await f.authorize(relay, client(1));
  expect(refused.headers.get("location")).toContain("error=temporarily_unavailable");
  expect(waits(await f.authorize(relay, client(2)))).toBe(true);
});

test("one way in can keep only so many sign-ins waiting, whichever clients ask", async () => {
  const f = surface();
  for (let i = 0; i < pendingLimits.perBase; i++)
    expect(waits(await f.authorize(relay, client(i)))).toBe(true);
  const refused = await f.authorize(relay, client(99));
  expect(refused.headers.get("location")).toContain("error=temporarily_unavailable");
  // Another way in has its own room.
  expect(waits(await f.authorize(local, client(99)))).toBe(true);
});

test("a sign-in whose page stops reloading leaves the person's list", async () => {
  const f = surface();
  const kept = await f.authorize(relay, client(1));
  const left = await f.authorize(relay, client(2));
  expect(f.outside.requests.current()).toHaveLength(2);
  const keptPage = new URL(kept.headers.get("location") ?? "");
  // The kept page reloads as the browser does; the other is closed.
  for (let elapsed = 0; elapsed < abandonedAfterMs + 2_000; elapsed += 2_000) {
    f.advance(2_000);
    await f.call(relay, `/authorize/wait${keptPage.search}`);
  }
  expect(f.outside.requests.current()).toHaveLength(1);
  const leftPage = new URL(left.headers.get("location") ?? "");
  const ended = await f.call(relay, `/authorize/wait${leftPage.search}`, { redirect: "manual" });
  expect(ended.headers.get("location")).toContain("error=access_denied");
});

test("callers who hammer /authorize or /register are told to wait, each address on its own", async () => {
  const f = surface();
  const tailnet = outsideBase("tailscale", "https://studio.tail1.ts.net");
  for (let i = 0; i < callLimits.authorize; i++)
    await f.authorize(tailnet, client(i % 2), "100.64.0.5");
  expect((await f.authorize(tailnet, client(1), "100.64.0.5")).status).toBe(429);
  expect((await f.authorize(tailnet, client(1), "100.64.0.6")).status).not.toBe(429);
  const register = () =>
    f.call(relay, "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
    });
  for (let i = 0; i < callLimits.register; i++) expect((await register()).status).toBe(201);
  expect((await register()).status).toBe(429);
  f.advance(60_000);
  expect((await register()).status).toBe(201);
});

test("on loopback, a web page can't register a client or read the reply", async () => {
  const f = surface();
  const fromPage = await f.call(local, "/register", {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://evil.example" },
    body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
  });
  expect(fromPage.status).toBe(400);
  const preflight = await f.call(local, "/register", { method: "OPTIONS" });
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  const json = await f.call(local, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
  });
  expect(json.status).toBe(201);
  expect(json.headers.get("access-control-allow-origin")).toBeNull();
  // Elsewhere, browser-based clients may register.
  const relayed = await f.call(relay, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
  });
  expect(relayed.headers.get("access-control-allow-origin")).toBe("*");
});
