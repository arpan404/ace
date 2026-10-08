import { writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createFileWatcher, fileIO, SettingsService } from "./index.ts";
import { fixture } from "./test-support.ts";

test("inactive thread scopes share native watch capacity and closing a peer keeps settings delivery alive", async () => {
  const env = await fixture();
  // The uncontrollable native notification boundary admits only one directory
  // watch. Real files, the scope LRU and settings resolution remain in use.
  let source: ((filename: string | null) => void) | undefined;
  const io = {
    ...fileIO,
    watch: createFileWatcher((_path, changed) => {
      if (source) throw new Error("Native watch capacity exhausted");
      source = changed;
      return () => {
        source = undefined;
      };
    }),
  };
  const first = new SettingsService({ dataDir: env.dataDir, io });
  const second = new SettingsService({ dataDir: env.dataDir, io });
  try {
    for (let index = 0; index < 100; index++) {
      const value = await first.read({
        keys: ["threads.settleOnClose"],
        scope: { thread: `closed-${index}` },
      });
      expect(value.diagnostics).toEqual([]);
      expect(value.entries[0]?.value).toBe(false);
    }
    const notice = Promise.withResolvers<unknown>();
    await second.subscribe({ keys: ["threads.settleOnClose"], scope: {} }, notice.resolve);
    await first.close();
    await writeFile(env.globalPath, '{"version":2,"settings":{"threads.settleOnClose":true}}');
    if (!source) throw new Error("Peer lost its native notification source");
    source("settings.json");
    expect(await notice.promise).toMatchObject({ type: "changed", entries: [{ value: true }] });
    await second.close();
    expect(source).toBeUndefined();
  } finally {
    await first.close();
    await second.close();
    await env.close();
  }
});
