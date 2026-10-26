import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { batches, fixture } from "./test-support.ts";

// Windows watches the whole root with one recursive watch; filtering is what keeps ignored
// folders and Git internals out of the batches.
describe.runIf(process.platform === "win32")("Windows recursive watching", () => {
  test("reports nothing for ignored folders or Git internals, and nothing on an idle flush", async () => {
    const { service, file } = await fixture({}, true);
    await file(".gitignore", "node_modules/\n");
    for (let i = 0; i < 20; i++) await file(`node_modules/pkg${i}/lib/index.js`, "x");
    await file("src/app/main.ts", "main");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      expect(watcher.mode).toBe("native");
      await watcher.flush();
      expect(events.history).toEqual([]);
      const created = events.next("src/app/new.ts", "created");
      await file("node_modules/pkg0/lib/late.js", "x");
      await file("node_modules/fresh/index.js", "x");
      await file(".git/ace-note", "x");
      await file("src/app/new.ts", "new");
      await created;
      await watcher.flush();
      expect(events.history.flat()).toEqual([{ path: "src/app/new.ts", kind: "created" }]);
    } finally {
      await watcher.dispose();
    }
  });

  test("a renamed folder reports every old path deleted and every new path created", async () => {
    const { service, root, file } = await fixture();
    await file("old/deep/a.ts", "a");
    await file("old/b.ts", "b");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      const moved = events.next("new/deep/a.ts", "created");
      await rename(join(root, "old"), join(root, "new"));
      await moved;
      await watcher.flush();
      const changes = events.history.flat();
      for (const path of ["old", "old/deep", "old/deep/a.ts", "old/b.ts"])
        expect(changes).toContainEqual({ path, kind: "deleted" });
      for (const path of ["new", "new/deep", "new/deep/a.ts", "new/b.ts"])
        expect(changes).toContainEqual({ path, kind: "created" });
      const removed = events.next("new/b.ts", "deleted");
      await rm(join(root, "new"), { recursive: true });
      await removed;
      await mkdir(join(root, "again"));
      const again = events.next("again/c.ts", "created");
      await file("again/c.ts", "c");
      await again;
    } finally {
      await watcher.dispose();
    }
  });
});
