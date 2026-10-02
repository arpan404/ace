import { watch, type FSWatcher } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitWorkspace, WorkspaceCache, type WorkspaceFiles } from "./index.ts";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { repository, run } from "./test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
test("subtree reconciliation removes tracked ignored and deleted descendants", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  await repo.write("src/private.txt", "secret");
  await repo.write("src/deleted.ts", "old");
  await run("git", ["-C", repo.root, "add", "src"]);
  await repo.write(".gitignore", "src/private.txt\n");
  await repo.workspace.initialize();
  await rm(join(repo.root, "src/deleted.ts"));
  await repo.write("src/new.ts", "new");
  await repo.workspace.update(["src"]);
  expect(repo.workspace.index.complete("private")).toEqual([]);
  expect(repo.workspace.index.complete("deleted")).toEqual([]);
  expect(repo.workspace.index.complete("new")).toEqual(["src/new.ts"]);
});
test("Git overflow rejection reaps a process that ignores SIGTERM", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  const pidFile = join(repo.root, "pid");
  await repo.write(
    "probe.cjs",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); process.stdout.write('x'.repeat(9000)); setInterval(()=>{},1000);`,
  );
  const workspace = new GitWorkspace(repo.root, 100000, {
    spawn: (options) =>
      spawnRawSupervised({
        ...options,
        command: process.execPath,
        args: [join(repo.root, "probe.cjs")],
      }),
  });
  await expect(workspace.inspect("probe.cjs")).rejects.toMatchObject({ code: "quota" });
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
test("cached completion serves the published index during an unfinished watcher update", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  await repo.write("old.ts", "old");
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const cache = new WorkspaceCache(4, (root) => {
    const git = new GitWorkspace(root);
    const workspace: WorkspaceFiles = {
      root,
      get index() {
        return git.index;
      },
      initialize: () => git.initialize(),
      inspect: (path) => git.inspect(path),
      read: (path, limit) => git.read(path, limit),
      update: async (paths) => {
        entered.resolve();
        await release.promise;
        await git.update(paths);
      },
    };
    return workspace;
  });
  cleanups.unshift(() => cache.close());
  await cache.get(repo.root);
  await repo.write("new.ts", "new");
  await entered.promise;
  const get = cache.get(repo.root);
  // A turn barrier permits queued cache work, without releasing the update.
  await new Promise<void>((resolve) => setImmediate(resolve));
  let published: string[] | undefined;
  void get.then((workspace) => {
    published = workspace.index.complete("old");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(published).toEqual(["old.ts"]);
  } finally {
    release.resolve();
    await get;
  }
});

test("cancellation rejects and reaps a Git process holding its output open", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  const pidFile = join(repo.root, "pid");
  await repo.write(
    "probe.cjs",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const workspace = new GitWorkspace(repo.root, 100000, {
    signal: controller.signal,
    spawn: (options) => {
      const child = spawnRawSupervised({
        ...options,
        command: process.execPath,
        args: [join(repo.root, "probe.cjs")],
      });
      child.stdout.once("data", () => controller.abort());
      return child;
    },
  });
  await expect(workspace.inspect("probe.cjs")).rejects.toMatchObject({ code: "busy" });
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("a transient ignore update failure recovers without another filesystem event", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  await repo.write("secret.txt", "secret");
  const scheduled = Promise.withResolvers<void>();
  const timers = new Map<number, () => Promise<void>>();
  let timerId = 0,
    failNext = true;
  let watcher: FSWatcher | undefined;
  const cache = new WorkspaceCache(
    4,
    (root) => {
      const git = new GitWorkspace(root);
      return {
        root,
        get index() {
          return git.index;
        },
        initialize: () => git.initialize(),
        inspect: (path) => git.inspect(path),
        read: (path, limit) => git.read(path, limit),
        update: async (paths) => {
          if (failNext && paths.includes(".gitignore")) {
            failNext = false;
            watcher?.close();
            throw new Error("transient I/O failure");
          }
          await git.update(paths);
        },
      };
    },
    {
      after: (_delay, task) => {
        const id = ++timerId;
        timers.set(id, task);
        scheduled.resolve();
        return () => {
          timers.delete(id);
        };
      },
    },
    (root) => {
      watcher = watch(root, { recursive: true });
      return watcher;
    },
  );
  cleanups.unshift(() => cache.close());
  expect((await cache.get(repo.root)).index.complete("secret")).toEqual(["secret.txt"]);
  await repo.write(".gitignore", "secret.txt\n");
  await scheduled.promise;
  const retry = timers.entries().next().value;
  if (retry) {
    timers.delete(retry[0]);
    await retry[1]();
  }
  // Advance injected retry time, then inspect public completion. No new change
  // notification or wall-clock budget is needed to observe recovery.
  expect((await cache.get(repo.root)).index.complete("secret")).toEqual([]);
});

test("watcher errors recover through a single backed-off timer which close cancels", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  await repo.write("old.ts", "old");
  const timers = new Map<number, { delay: number; task: () => Promise<void> }>();
  let scheduled = Promise.withResolvers<void>();
  let timerId = 0,
    unavailable = false;
  let watcher: FSWatcher | undefined;
  const cache = new WorkspaceCache(
    1,
    (root) => {
      const git = new GitWorkspace(root);
      return {
        root,
        get index() {
          return git.index;
        },
        initialize: async () => {
          if (unavailable) throw new Error("Git temporarily unavailable");
          await git.initialize();
        },
        inspect: (path) => git.inspect(path),
        read: (path, limit) => git.read(path, limit),
        update: (paths) => git.update(paths),
      };
    },
    {
      after: (delay, task) => {
        const id = ++timerId;
        timers.set(id, { delay, task });
        scheduled.resolve();
        return () => {
          timers.delete(id);
        };
      },
    },
    (root) => {
      watcher = watch(root, { recursive: true });
      return watcher;
    },
  );
  cleanups.unshift(() => cache.close());
  await cache.get(repo.root);
  unavailable = true;
  watcher?.emit("error", new Error("lost watcher"));
  await scheduled.promise;
  watcher?.emit("change", "change", "old.ts");
  for (const expectedDelay of [100, 200, 400]) {
    expect([...timers.values()].map((timer) => timer.delay)).toEqual([expectedDelay]);
    expect((await cache.get(repo.root)).index.complete("old")).toEqual(["old.ts"]);
    const next = timers.entries().next().value;
    if (!next) throw new Error("Expected recovery timer");
    timers.delete(next[0]);
    scheduled = Promise.withResolvers<void>();
    await next[1].task();
    await scheduled.promise;
  }
  await cache.close();
  expect([...timers]).toEqual([]);
  await expect(cache.get(repo.root)).rejects.toMatchObject({ code: "busy" });
});

test("a rearmed watcher's queued change is drained without another notification", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  await repo.write("old.ts", "old");
  const published = Promise.withResolvers<void>();
  let recovering = false;
  let watcher: FSWatcher | undefined;
  const cache = new WorkspaceCache(
    1,
    (root) => {
      const git = new GitWorkspace(root);
      return {
        root,
        get index() {
          return git.index;
        },
        initialize: async () => {
          await git.initialize();
          // The lost watcher is closed. This file arrives after the replacement
          // index was built, so only the rearmed watch can add it.
          if (recovering) await repo.write("late.ts", "late");
        },
        inspect: (path) => git.inspect(path),
        read: (path, limit) => git.read(path, limit),
        update: async (paths) => {
          await git.update(paths);
          if (paths.includes("late.ts")) published.resolve();
        },
      };
    },
    undefined,
    (root) => {
      const source = watch(root, { recursive: true });
      watcher = source;
      // Delivery on the next microtask models a notification queued as the
      // replacement watcher starts, while the rebuild drain is settling.
      if (recovering) queueMicrotask(() => source.emit("change", "rename", "late.ts"));
      return source;
    },
  );
  cleanups.unshift(() => cache.close());
  await cache.get(repo.root);
  recovering = true;
  watcher?.close();
  watcher?.emit("error", new Error("lost watcher"));
  await published.promise;
  expect((await cache.get(repo.root)).index.complete("late")).toEqual(["late.ts"]);
});

test("cancelling an incomplete Git listing reports cancellation after reaping", async () => {
  const repo = await repository();
  cleanups.push(repo.close);
  const pidFile = join(repo.root, "pid");
  await repo.write(
    "probe.cjs",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); process.stdout.write('incomplete'); setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const workspace = new GitWorkspace(repo.root, 100000, {
    signal: controller.signal,
    spawn: (options) => {
      const child = spawnRawSupervised({
        ...options,
        command: process.execPath,
        args: [join(repo.root, "probe.cjs")],
      });
      child.stdout.once("data", () => controller.abort());
      return child;
    },
  });
  await expect(workspace.initialize()).rejects.toMatchObject({
    code: "busy",
    message: "Git operation cancelled",
  });
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
