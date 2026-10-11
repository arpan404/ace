import { once } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitWorkspace, WorkspaceCache, resolveMentions } from "./index.ts";
import { repository } from "./test-support.ts";

test.each(["creation", "deletion", "ignore"])(
  "a real replacement watcher captures %s after the recovery inventory cut",
  async (change) => {
    const repo = await repository();
    let source: FSWatcher | undefined;
    let recovering = false;
    const written = Promise.withResolvers<void>();
    const cache = new WorkspaceCache(
      1,
      (root) => {
        const git = new GitWorkspace(root);
        return {
          root,
          get index() {
            return git.index;
          },
          inspect: (path) => git.inspect(path),
          read: (path, limit) => git.read(path, limit),
          update: (paths) => git.update(paths),
          async initialize() {
            await git.initialize();
            if (recovering) {
              recovering = false;
              if (change === "creation") await repo.write("src/late.ts", "late");
              else if (change === "deletion") await rm(join(root, "src/late.ts"));
              else await repo.write(".gitignore", "src/late.ts\n");
              written.resolve();
            }
          },
        };
      },
      undefined,
      (root) => {
        source = watch(root, { recursive: true });
        return source;
      },
    );
    try {
      await repo.write("src/kept.ts", "kept");
      if (change !== "creation") await repo.write("src/late.ts", "late");
      const workspace = await cache.get(repo.root);
      recovering = true;
      if (!source) throw new Error("Missing initial watcher");
      const closed = once(source, "close");
      source.close();
      await closed;
      source.emit("error", new Error("lost notification source"));
      await written.promise;
      await expect
        .poll(() => workspace.index.complete("late"), { timeout: 30000 })
        .toEqual(change === "creation" ? ["src/late.ts"] : []);
      expect(
        (await resolveMentions(workspace, [{ path: "src" }])).entries
          .map((entry) => entry.path)
          .toSorted(),
      ).toEqual(change === "creation" ? ["src/kept.ts", "src/late.ts"] : ["src/kept.ts"]);
    } finally {
      await cache.close();
      await repo.close();
    }
  },
);

test.each(["close", "evict"])(
  "%s during recovery drains its scan and closes every source without rearming",
  async (action) => {
    const repo = await repository();
    const other = await repository();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const closed: Promise<unknown>[] = [];
    let source: FSWatcher | undefined;
    let recovering = false;
    const cache = new WorkspaceCache(
      1,
      (root) => {
        const git = new GitWorkspace(root);
        return {
          root,
          get index() {
            return git.index;
          },
          inspect: (path) => git.inspect(path),
          read: (path, limit) => git.read(path, limit),
          update: (paths) => git.update(paths),
          async initialize() {
            if (root === repo.root && recovering) {
              entered.resolve();
              await release.promise;
            }
            await git.initialize();
          },
        };
      },
      undefined,
      (root) => {
        const handle = watch(root, { recursive: true });
        closed.push(new Promise<void>((resolve) => handle.once("close", resolve)));
        if (root === repo.root) source = handle;
        return handle;
      },
    );
    try {
      await repo.write("kept.ts", "kept");
      const workspace = await cache.get(repo.root);
      recovering = true;
      source?.emit("error", new Error("lost watcher"));
      await entered.promise;
      const stopping = action === "close" ? cache.close() : cache.get(other.root);
      release.resolve();
      await stopping;
      await repo.write("late.ts", "late");
      source?.emit("change", "rename", "late.ts");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(workspace.index.complete("late")).toEqual([]);
      await cache.close();
      await Promise.all(closed);
    } finally {
      release.resolve();
      await cache.close();
      await repo.close();
      await other.close();
    }
  },
);
