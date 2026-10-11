import { watch } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { GitWorkspace, WorkspaceCache, resolveMentions } from "./index.ts";
import { repository } from "./test-support.ts";

test.each(["file", "subtree"])(
  "a failed ordinary %s update preserves completion and recovers through the cache retry",
  async (kind) => {
    const repo = await repository();
    const timers = new Set<() => Promise<void>>();
    const failed = Promise.withResolvers<void>();
    let failing = false;
    const changed = kind === "file" ? "src/kept.ts" : "src";
    const git = new GitWorkspace(repo.root, 100000, {
      spawn(options) {
        const args = options.args ?? [];
        const targeted =
          kind === "file"
            ? args.includes("check-ignore")
            : args.includes("ls-files") && args.includes("src");
        if (failing && targeted) {
          failed.resolve();
          throw new Error("temporary Git launch failure");
        }
        return spawnRawSupervised(options);
      },
    });
    const source = watch(repo.root, { recursive: true });
    const cache = new WorkspaceCache(
      1,
      () => git,
      {
        after(_delay, task) {
          timers.add(task);
          return () => {
            timers.delete(task);
          };
        },
      },
      () => source,
    );
    try {
      await repo.write("src/kept.ts", "old");
      const workspace = await cache.get(repo.root);
      source.close();
      await repo.write("src/new.ts", "new");
      failing = true;
      source.emit("change", "change", changed);
      await failed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(workspace.index.complete("kept")).toEqual(["src/kept.ts"]);
      expect(timers.size).toBe(1);
      failing = false;
      const retry = timers.values().next().value;
      if (!retry) throw new Error("Expected recovery");
      timers.delete(retry);
      await retry();
      expect(workspace.index.complete("new")).toEqual(["src/new.ts"]);
      expect(
        (await resolveMentions(workspace, [{ path: "src" }])).entries
          .map((entry) => entry.path)
          .toSorted(),
      ).toEqual(["src/kept.ts", "src/new.ts"]);
      await rm(join(repo.root, "src/kept.ts"));
      await workspace.update(["src/kept.ts"]);
      expect(workspace.index.complete("kept")).toEqual([]);
      await repo.write(".gitignore", "src/new.ts\n");
      await workspace.update(["src/new.ts"]);
      expect(workspace.index.complete("new")).toEqual([]);
    } finally {
      await cache.close();
      await repo.close();
    }
  },
);
