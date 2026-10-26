import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { batches, fixture } from "./test-support.ts";

// Windows watches the whole root with one recursive watch; filtering is what keeps ignored
// folders and Git internals out of the batches.
describe.runIf(process.platform === "win32")("Windows recursive watching", () => {
  test("reports nothing for ignored folders or Git internals", async () => {
    const { service, file } = await fixture({}, true);
    await file(".gitignore", "node_modules/\n");
    for (let i = 0; i < 20; i++) await file(`node_modules/pkg${i}/lib/index.js`, "x");
    await file("src/app/main.ts", "main");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      expect(watcher.mode).toBe("native");
      const created = events.next("src/app/new.ts", "created");
      await file("node_modules/pkg0/lib/late.js", "x");
      await file("node_modules/fresh/index.js", "x");
      await file(".git/ace-note", "x");
      await file("src/app/new.ts", "new");
      await created;
      await watcher.flush();
      const changes = events.history.flat();
      expect(changes).toContainEqual({ path: "src/app/new.ts", kind: "created" });
      // NTFS may settle a folder's timestamp late, so "src" can read as changed; nothing else may.
      expect(changes.filter((change) => !["src", "src/app"].includes(change.path))).toEqual([
        { path: "src/app/new.ts", kind: "created" },
      ]);
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

  // Native timers are held, so only flush() reconciles; slow runners otherwise start a scan of
  // their own between the writes and the count.
  test("one ignore process reconciles nested visible files and prunes ignored folders on flush", async () => {
    let processes = 0;
    const h = await fixture(
      {
        runtime: {
          spawn(binary, args, options) {
            processes++;
            return spawn(binary, args, options);
          },
          clock: {
            after() {
              return () => {};
            },
            every() {
              throw new Error("Native watching must not poll");
            },
          },
        },
      },
      true,
    );
    await h.file(".gitignore", "ignored/\n*.log\n!keep.log\n");
    await h.file("old/a/b/c.ts", "original");
    const events = batches();
    const watcher = await h.service.watch({ onChange: events.onChange });
    try {
      await h.file("old/a/b/c.ts", "changed");
      await h.file("new/a/b/file.ts", "visible");
      await h.file("new/a/b/keep.log", "visible negation");
      await h.file("new/a/b/hide.log", "hidden");
      await h.file("ignored/deep/file.ts", "hidden directory");
      const before = processes;
      await watcher.flush();
      expect(processes - before).toBe(1);
      expect(events.history.flat()).toEqual(
        expect.arrayContaining([
          { path: "old/a/b/c.ts", kind: "changed" },
          { path: "new/a/b/file.ts", kind: "created" },
          { path: "new/a/b/keep.log", kind: "created" },
        ]),
      );
      expect(
        events.history
          .flat()
          .some((change) => change.path.includes("hide.log") || change.path.startsWith("ignored")),
      ).toBe(false);
    } finally {
      await watcher.dispose();
    }
  });
});
