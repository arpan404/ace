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
const noop = () => {};

function service(answers: { site?: Buffer | null | undefined; app?: Buffer | null }) {
  const home = mkdtempSync(join(tmpdir(), "ace-icons-"));
  homes.push(home);
  let now = 1_000;
  const asked: string[] = [];
  let release: () => void = noop;
  const gate = { held: false };
  const icons = new IconService({
    cache: new IconCache(home),
    site: async (icon) => {
      asked.push(icon.kind === "site" ? icon.origin : "");
      if (gate.held) await new Promise<void>((resolve) => (release = resolve));
      return answers.site;
    },
    app: async (icon) => {
      asked.push(icon.kind === "app" ? icon.identity : "");
      return answers.app ?? null;
    },
    // Normalising is the decoder's concern; here bytes pass through.
    normalize: async (bytes) => bytes,
    now: () => now,
  });
  return {
    home,
    icons,
    asked,
    gate,
    release: () => release(),
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
  expect(s.icons.read(first ?? "")).toEqual(png);
  expect(s.icons.cached(github)).toBe(first);
  // A restart reads the disk, not the site.
  const again = new IconService({
    cache: new IconCache(s.home),
    site: async () => {
      throw new Error("must not fetch");
    },
    app: async () => null,
    normalize: async (bytes) => bytes,
    now: () => 2_000,
  });
  expect(await again.resolve(github)).toBe(first);
});

// Mutations: forgetting misses, or remembering passing failures.
test("a site without a favicon is not asked again for a day; a passing failure is", async () => {
  const none = service({ site: null });
  expect(await none.icons.resolve(github)).toBeNull();
  expect(await none.icons.resolve(github)).toBeNull();
  expect(none.asked).toHaveLength(1);
  none.advance(day + 1);
  await none.icons.resolve(github);
  expect(none.asked).toHaveLength(2);

  const offline = service({ site: undefined });
  expect(await offline.icons.resolve(github)).toBeNull();
  expect(await offline.icons.resolve(github)).toBeNull();
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

test("app icons resolve through the app source, never the site fetcher", async () => {
  const s = service({ app: Buffer.from("app") });
  const ref = await s.icons.resolve(xcode);
  expect(ref).toMatch(/^[a-f0-9]{64}$/);
  expect(s.asked).toEqual(["com.apple.dt.Xcode"]);
});
