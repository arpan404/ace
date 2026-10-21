import { watch as nodeWatch } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceRuntime } from "./runtime.ts";
import { batches, fixture } from "./test-support.ts";

/** Forces the Linux strategy on any host and records which directories hold an OS watch. */
function linuxRuntime() {
  const open = new Map<string, number>();
  const watch: WorkspaceRuntime["watch"] = (path, options, listener) => {
    const watcher = nodeWatch(path, options, listener);
    open.set(path, (open.get(path) ?? 0) + 1);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      const count = (open.get(path) ?? 1) - 1;
      if (count) open.set(path, count);
      else open.delete(path);
      close();
    };
    return watcher;
  };
  return { runtime: { platform: "linux" as const, watch }, open };
}

async function inotifyWatches(): Promise<number> {
  let total = 0;
  for (const fd of await readdir("/proc/self/fdinfo")) {
    const info = await readFile(`/proc/self/fdinfo/${fd}`, "utf8").catch(() => "");
    total += info.split("\n").filter((line) => line.startsWith("inotify wd:")).length;
  }
  return total;
}

describe("per-directory watching on Linux", () => {
  it("never places a watch inside ignored or Git directories", async () => {
    const { runtime, open } = linuxRuntime();
    const { service, root, file } = await fixture({ runtime }, true);
    await file(".gitignore", "node_modules/\n");
    for (let i = 0; i < 50; i++) await file(`node_modules/pkg${i}/lib/index.js`, "x");
    await file("src/app/main.ts", "main");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      // Rescanning newly watched directories for racing entries reports nothing by itself.
      await watcher.flush();
      expect(events.history).toEqual([]);
      const watched = [...open.keys()];
      expect(watched).toContain(join(root, "src/app"));
      expect(watched.some((path) => path.includes("node_modules"))).toBe(false);
      // Git metadata folders are watched one level deep; objects and refs never are.
      expect(
        watched.filter((path) => path.startsWith(join(root, ".git") + "/")).toSorted(),
      ).toEqual([join(root, ".git/info")]);
      const created = events.next("src/app/new.ts", "created");
      await file("src/app/new.ts", "new");
      await created;
    } finally {
      await watcher.dispose();
    }
    expect(open.size).toBe(0);
  });

  it("reports files written into directories created after watching began", async () => {
    const { runtime } = linuxRuntime();
    const { service, file } = await fixture({ runtime });
    await file("keep.ts", "keep");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      const nested = events.next("a/b/c/first.ts", "created");
      await file("a/b/c/first.ts", "first");
      await nested;
      // The second write proves a watch now exists on the new leaf directory.
      const later = events.next("a/b/c/second.ts", "created");
      await file("a/b/c/second.ts", "second");
      await later;
    } finally {
      await watcher.dispose();
    }
  });

  it("keeps reporting a directory that was deleted and recreated", async () => {
    const { runtime, open } = linuxRuntime();
    const { service, root, file } = await fixture({ runtime });
    await file("pkg/one.ts", "one");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      const deleted = events.next("pkg/one.ts", "deleted");
      await rm(join(root, "pkg"), { recursive: true });
      await deleted;
      await mkdir(join(root, "pkg"));
      const recreated = events.next("pkg/two.ts", "created");
      await writeFile(join(root, "pkg/two.ts"), "two");
      await recreated;
      const again = events.next("pkg/three.ts", "created");
      await writeFile(join(root, "pkg/three.ts"), "three");
      await again;
    } finally {
      await watcher.dispose();
    }
    expect(open.size).toBe(0);
  });

  it("starts watching a directory once it is no longer ignored", async () => {
    const { runtime, open } = linuxRuntime();
    const { service, root, file } = await fixture({ runtime }, true);
    await file(".gitignore", "build/\n");
    await file("build/out/a.js", "a");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      expect(open.has(join(root, "build/out"))).toBe(false);
      const visible = events.next("build/out/a.js", "created");
      await file(".gitignore", "");
      await visible;
      expect(open.has(join(root, "build/out"))).toBe(true);
      const created = events.next("build/out/b.js", "created");
      await file("build/out/b.js", "b");
      await created;
      const hidden = events.next("build/out/b.js", "deleted");
      await file(".gitignore", "build/\n");
      await hidden;
      expect(open.has(join(root, "build/out"))).toBe(false);
    } finally {
      await watcher.dispose();
    }
  });

  it("still reconciles branch switches from Git metadata inside the workspace", async () => {
    const { runtime } = linuxRuntime();
    const { service, root, file } = await fixture({ runtime }, true);
    await file(".gitignore", "");
    await file("tracked.ts", "x");
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      // Ignore rules in .git/info/exclude are only reachable through a metadata watch.
      const hidden = events.next("tracked.ts", "deleted");
      await mkdir(join(root, ".git/info"), { recursive: true });
      await writeFile(join(root, ".git/info/exclude"), "tracked.ts\n");
      await hidden;
    } finally {
      await watcher.dispose();
    }
  });

  it.runIf(process.platform === "linux")(
    "keeps the inotify watch count independent of ignored dependency trees",
    async () => {
      const { service, file } = await fixture({}, true);
      await file(".gitignore", "node_modules/\n");
      for (let i = 0; i < 300; i++) await file(`node_modules/pkg${i}/dist/index.js`, "x");
      await file("src/index.ts", "x");
      const before = await inotifyWatches();
      const watcher = await service.watch({ onChange: () => {} });
      try {
        // Root, src, and a handful of Git metadata folders; never the 600 ignored ones.
        expect((await inotifyWatches()) - before).toBeLessThan(20);
      } finally {
        await watcher.dispose();
      }
    },
  );
});
