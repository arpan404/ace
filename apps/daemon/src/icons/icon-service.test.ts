import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ToolIcon } from "@ace/protocol";
import { IconCache } from "./icon-cache.ts";
import { IconService } from "./icon-service.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const github: ToolIcon = { kind: "site", origin: "https://github.com" };
const xcode: ToolIcon = { kind: "app", identity: "com.apple.dt.Xcode", name: "Xcode" };
const day = 24 * 3600_000;
const site = (name: string): ToolIcon => ({ kind: "site", origin: `https://${name}.example` });
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "ace-icons-"));
  homes.push(path);
  return path;
};

function service(answers: { site?: Buffer | null | undefined; app?: Buffer | null }, limit = 8) {
  const root = home();
  let now = 1_000;
  const asked: string[] = [];
  const gates: (() => void)[] = [];
  const gate = { held: false };
  let running = 0;
  let most = 0;
  const icons = new IconService({
    cache: new IconCache(root),
    site: async (icon) => {
      asked.push(icon.kind === "site" ? icon.origin : "");
      running++;
      most = Math.max(most, running);
      if (gate.held) await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return answers.site;
    },
    app: async (icon) => {
      asked.push(icon.kind === "app" ? icon.identity : "");
      return answers.app ?? null;
    },
    // Normalising is the decoder's concern; here bytes pass through.
    normalize: async (bytes) => bytes,
    now: () => now,
    limit,
  });
  return {
    root,
    icons,
    asked,
    gate,
    most: () => most,
    release: () => {
      for (const open of gates.splice(0)) open();
    },
    advance: (ms: number) => (now += ms),
  };
}

// Mutations: fetching once per request, or keying the cache by more than the origin.
test("a site's icon is fetched once, shared by concurrent rows, and read back by its hash", async () => {
  const png = Buffer.from("png-bytes");
  const s = service({ site: png });
  s.gate.held = true;
  const both = Promise.all([s.icons.resolve(github), s.icons.resolve(github)]);
  await Promise.resolve();
  s.release();
  const [first, second] = await both;
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(second).toBe(first);
  expect(s.asked).toEqual(["https://github.com"]);
  expect(await s.icons.read(first ?? "")).toEqual(png);
  expect(s.icons.cached(github)).toBe(first);
});

// Mutations: forgetting misses, or remembering passing failures as "none".
test("a site without a favicon is not asked again for a day; a passing failure says later", async () => {
  const none = service({ site: null });
  expect(await none.icons.resolve(github)).toBeNull();
  expect(await none.icons.resolve(github)).toBeNull();
  expect(none.asked).toHaveLength(1);
  none.advance(day + 1);
  await none.icons.resolve(github);
  expect(none.asked).toHaveLength(2);

  const offline = service({ site: undefined });
  expect(await offline.icons.resolve(github)).toBeUndefined();
  expect(await offline.icons.resolve(github)).toBeUndefined();
  expect(offline.asked).toHaveLength(2);
  expect(offline.icons.cached(github)).toBeUndefined();
});

// Mutation: blocking a row on the refresh of an icon past its lifetime.
test("an icon past its lifetime still answers at once while it is fetched again", async () => {
  const s = service({ site: Buffer.from("old") });
  const old = await s.icons.resolve(github);
  s.advance(8 * day);
  s.gate.held = true;
  expect(await s.icons.resolve(github)).toBe(old);
  expect(s.asked).toHaveLength(2);
  s.release();
});

// Mutation: letting a waiter start between one lookup finishing and the next taking its slot.
test("never more lookups run at once than the limit, however many sites wait", async () => {
  const s = service({ site: Buffer.from("x") }, 2);
  s.gate.held = true;
  const sites = Array.from({ length: 6 }, (_, index): ToolIcon => ({
    kind: "site",
    origin: `https://site${index}.example`,
  }));
  const all = Promise.all(sites.map((icon) => s.icons.resolve(icon)));
  for (let round = 0; round < 6; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.release();
  }
  await all;
  expect(s.most()).toBe(2);
});

test("app icons resolve through the app source, never the site fetcher", async () => {
  const s = service({ app: Buffer.from("app") });
  const ref = await s.icons.resolve(xcode);
  expect(ref).toMatch(/^[a-f0-9]{64}$/);
  expect(s.asked).toEqual(["com.apple.dt.Xcode"]);
});

// Mutations: an unbounded cache, or evicting the icon just used.
test("the disk cache keeps at most its limit, dropping the least recently used icon", async () => {
  const root = home();
  const cache = new IconCache(root, { maxIcons: 2, maxBytes: 1024 });
  const a = await cache.store(site("a"), Buffer.from("a"), 1);
  const b = await cache.store(site("b"), Buffer.from("b"), 1);
  await cache.read(a ?? "");
  await cache.store(site("c"), Buffer.from("c"), 1);
  expect(cache.size.icons).toBe(2);
  expect(await cache.read(b ?? "")).toBeUndefined();
  expect(cache.lookup(site("b"), 2)).toBeUndefined();
  expect(cache.lookup(site("a"), 2)?.ref).toBe(a);
  // A restart reads what was kept, without asking anyone.
  await cache.flushed();
  const again = new IconCache(root, { maxIcons: 2, maxBytes: 1024 });
  expect(again.lookup(site("a"), 2)?.ref).toBe(a);
  expect(again.lookup(site("b"), 2)).toBeUndefined();
  const big = new IconCache(home(), { maxIcons: 10, maxBytes: 4 });
  await big.store(site("big"), Buffer.alloc(8, 1), 1);
  expect(big.size.bytes).toBeLessThanOrEqual(4);
});

// Mutation: writing (and counting) one icon twice when two sites share it at once.
test("the same icon stored for two sites at once is written and counted once", async () => {
  const cache = new IconCache(home(), { maxIcons: 10, maxBytes: 1024 });
  const png = Buffer.from("shared");
  const [a, b] = await Promise.all([
    cache.store(site("a"), png, 1),
    cache.store(site("b"), png, 1),
  ]);
  expect(a).toBe(b);
  expect(cache.size).toEqual({ icons: 1, bytes: png.length });
});
