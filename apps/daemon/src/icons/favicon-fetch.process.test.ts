import { afterEach, expect, test } from "vitest";
import { fetchFavicon } from "./favicon-fetch.ts";
import { localSite } from "./local-site.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function site(routes: Parameters<typeof localSite>[0]) {
  const s = await localSite(routes);
  closers.push(s.close);
  return s;
}

// Mutation: sending identifying headers with a public request.
test("a site's favicon.ico comes back, asked for with nothing that identifies the person", async () => {
  const s = await site({ "/favicon.ico": Buffer.from("ico") });
  const bytes = await fetchFavicon(s.origin, { allowed: s.allowed, timeoutMs: 500 });
  expect(bytes?.toString()).toBe("ico");
  expect(s.seen.map((request) => request.path)).toEqual(["/favicon.ico"]);
  for (const request of s.seen) {
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
  }
});

// Mutation: stopping at a missing favicon.ico.
test("without favicon.ico, the icon the home page declares is used", async () => {
  const s = await site({
    "/": { html: '<html><head><link rel="icon" href="/static/mark.png"></head></html>' },
    "/static/mark.png": Buffer.from("mark"),
  });
  const bytes = await fetchFavicon(s.origin, { allowed: s.allowed, timeoutMs: 500 });
  expect(bytes?.toString()).toBe("mark");
  expect(s.seen.map((request) => request.path)).toEqual(["/favicon.ico", "/", "/static/mark.png"]);
});

test("a site with no icon has none; one that does not answer may be asked again later", async () => {
  const empty = await site({});
  expect(await fetchFavicon(empty.origin, { allowed: empty.allowed, timeoutMs: 500 })).toBeNull();
  const hanging = await site({ "/favicon.ico": "hang", "/": "hang" });
  expect(
    await fetchFavicon(hanging.origin, { allowed: hanging.allowed, timeoutMs: 300 }),
  ).toBeUndefined();
});

// Mutation: fetching the local network under the default policy.
test("a loopback or private origin is never fetched", async () => {
  const s = await site({ "/favicon.ico": Buffer.from("ico") });
  expect(await fetchFavicon(s.origin, { timeoutMs: 500 })).toBeNull();
  expect(s.seen).toHaveLength(0);
});
