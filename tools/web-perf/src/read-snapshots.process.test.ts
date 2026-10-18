import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { expect, inject, test } from "vitest";

/** Exercise native IndexedDB transactions on a fresh origin, never the owner's browser data. */
test("read snapshots enforce hard disk budgets and isolate credentials without persisting them", async () => {
  const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
  const root = await mkdtemp(join(tmpdir(), "ace-read-snapshots-"));
  const server = createServer();
  try {
    const entry = join(root, "entry.ts");
    const adapter = fileURLToPath(
      new URL("../../../apps/web/src/boot/read-snapshots.ts", import.meta.url),
    );
    const cache = fileURLToPath(new URL("../../../apps/web/src/lib/idb-cache.ts", import.meta.url));
    await writeFile(
      entry,
      `export { browserReadSnapshots } from ${JSON.stringify(adapter)};\nexport { idbCache } from ${JSON.stringify(cache)};`,
    );
    const bundle = join(root, "adapter.js");
    await promisify(execFile)("bun", ["build", entry, "--target=browser", `--outfile=${bundle}`]);
    const source = await readFile(bundle, "utf8");
    server.on("request", (request, response) => {
      response.setHeader(
        "content-type",
        request.url === "/adapter.js" ? "application/javascript" : "text/html",
      );
      response.end(
        request.url === "/adapter.js" ? source : "<!doctype html><title>Read cache</title>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local server");
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    const result: unknown = await page.evaluate(`(async () => {
      const { browserReadSnapshots, idbCache } = await import('/adapter.js');
      let clock = 0;
      const options = { name: 'bounds', maxEntries: 2, maxBytes: 24,
        decode: v => v, weigh: v => v.length * 2, now: () => ++clock, later: () => {} };
      const cache = idbCache(options);
      const other = idbCache(options);
      await Promise.all([cache.set('a', '1234'), other.set('b', '1234'), cache.set('c', '1234')]);
      // Bounds hold before any delayed housekeeping runs, even with concurrent adapters.
      const retained = await Promise.all(['a','b','c'].map(k => cache.get(k)));
      await cache.set('d', '12345678');
      const afterLarge = await Promise.all(['b','c','d'].map(k => cache.get(k)));
      await cache.set('huge', 'x'.repeat(100));
      const huge = await cache.get('huge');
      const lru = idbCache({ ...options, name: 'lru', maxBytes: 100 });
      await lru.set('a', 'first'); await lru.set('b', 'second');
      await lru.get('a'); await lru.set('c', 'third');
      const recentlyUsed = await Promise.all(['a','b','c'].map(k => lru.get(k)));
      const target = { url: 'ws://localhost:1234/', deviceId: 'device', token: 'private-token' };
      await browserReadSnapshots(target).set('thread:one', { version: 1, text: 'cached' });
      const warm = await browserReadSnapshots(target).get('thread:one');
      const misses = await Promise.all([
        { token: 'another-token' }, { deviceId: 'another-device' },
        { url: 'ws://localhost:4321/' }, { localHostId: 'new-home' }, { pairedDeviceId: 'another-account' },
      ].map(change => browserReadSnapshots({ ...target, ...change }).get('thread:one')));
      for (let i = 0; i < 35; i++) await browserReadSnapshots(target).set('thread:' + i, { version: 1, text: 'small' });
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('ace.read-snapshots'); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
      const rows = await Promise.all(['values','usage'].map(name => new Promise((resolve, reject) => {
        const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = reject;
      })));
      const keys = await new Promise((resolve, reject) => { const r = db.transaction('values').objectStore('values').getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
      db.close();
      return { retained, afterLarge, recentlyUsed, entries: keys.length, huge: huge ?? null, warm, misses: misses.map(v => v ?? null), disk: JSON.stringify([rows, keys]) };
    })()`);
    expect(result).toMatchObject({
      retained: [undefined, "1234", "1234"],
      afterLarge: [undefined, undefined, "12345678"],
      recentlyUsed: ["first", undefined, "third"],
      entries: 32,
      huge: null,
      warm: { version: 1, text: "cached" },
      misses: [null, null, null, null, null],
    });
    expect(JSON.stringify(result)).not.toContain("private-token");
  } finally {
    await browser.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(root, { recursive: true, force: true });
  }
});
