import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import {
  GitWorkspace,
  PathIndex,
  WorkspaceCache,
  type CacheScheduler,
  type WorkspaceCacheLimits,
  type WorkspaceFiles,
} from "./index.ts";
import { repository } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const idleMs = 60_000,
  coalesceMs = 50;
/** One event-loop turn, so closed watcher handles report their close. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Injected time: tests decide when idle deadlines and coalescing windows pass. */
function manualTimers() {
  const armed = new Map<number, { delay: number; task: () => Promise<void> }>();
  let id = 0;
  const scheduler: CacheScheduler = {
    after(delay, task) {
      const key = ++id;
      armed.set(key, { delay, task });
      return () => {
        armed.delete(key);
      };
    },
  };
  return {
    scheduler,
    armed: (delay: number) => [...armed.values()].filter((timer) => timer.delay === delay).length,
    async pass(delay: number) {
      for (const [key, timer] of Array.from(armed))
        if (timer.delay === delay) {
          armed.delete(key);
          await timer.task();
        }
    },
  };
}

/**
 * Real Git and real watcher handles; counts inventories, Git launches and open
 * watchers. Handles watch an empty directory, so only hints a test delivers
 * arrive and no OS notification latency can reorder them.
 */
async function harness(limits: WorkspaceCacheLimits = {}, cap = 4) {
  const quiet = await realpath(await mkdtemp(join(tmpdir(), "ace-quiet-")));
  cleanups.push(() => rm(quiet, { recursive: true, force: true }));
  const timers = manualTimers();
  const launches: string[] = [];
  const watchers = new Map<string, FSWatcher[]>();
  let open = 0,
    inventories = 0;
  const cache = new WorkspaceCache(
    cap,
    (root) => {
      const git = new GitWorkspace(root, 100_000, {
        spawn(options) {
          launches.push(options.args?.includes("check-ignore") ? "check-ignore" : "other");
          return spawnRawSupervised(options);
        },
      });
      return {
        root,
        get index() {
          return git.index;
        },
        initialize: async () => {
          inventories++;
          await git.initialize();
        },
        inspect: (path) => git.inspect(path),
        read: (path, limit) => git.read(path, limit),
        update: (paths) => git.update(paths),
      } satisfies WorkspaceFiles;
    },
    undefined,
    (root) => {
      const handle = watch(quiet, { recursive: true });
      open++;
      handle.once("close", () => open--);
      watchers.set(root, [...(watchers.get(root) ?? []), handle]);
      return handle;
    },
    { idleMs, coalesceMs, timers: timers.scheduler, ...limits },
  );
  cleanups.unshift(() => cache.close());
  return {
    cache,
    timers,
    launches,
    get open() {
      return open;
    },
    get inventories() {
      return inventories;
    },
    /** Deliver a hint through the root's current watcher, as the OS would. */
    hint(root: string, path: string) {
      watchers.get(root)?.at(-1)?.emit("change", "rename", path);
    },
  };
}
async function repo() {
  const value = await repository();
  cleanups.push(value.close);
  return value;
}

test("sustained ignored-output churn costs one ignore check per coalescing window", async () => {
  const h = await harness();
  const r = await repo();
  await r.write(".gitignore", "dist/\n");
  await h.cache.get(r.root);
  for (let i = 0; i < 200; i++) await r.write(`dist/chunk-${i}.js`, "built");
  await r.write("src/fresh.ts", "fresh");
  h.launches.length = 0;
  for (let i = 0; i < 200; i++) h.hint(r.root, `dist/chunk-${i}.js`);
  h.hint(r.root, "src/fresh.ts");
  expect(h.timers.armed(coalesceMs)).toBe(1);
  expect(h.launches).toEqual([]);
  await h.timers.pass(coalesceMs);
  expect(h.launches).toEqual(["check-ignore"]);
  const workspace = await h.cache.get(r.root);
  expect(workspace.index.complete("chunk")).toEqual([]);
  expect(workspace.index.complete("fresh")).toEqual(["src/fresh.ts"]);
});

test("an idle workspace closes its watcher and reopens with changes made while closed", async () => {
  const h = await harness();
  const r = await repo();
  await r.write("visible.ts", "visible");
  await r.write("secret.ts", "secret");
  expect((await h.cache.get(r.root)).index.complete("secret")).toEqual(["secret.ts"]);
  expect(h.open).toBe(1);
  await h.timers.pass(idleMs);
  await settle();
  expect(h.open).toBe(0);
  // No watcher observes these; reuse must still see them.
  await r.write(".gitignore", "secret.ts\n");
  await r.write("later.ts", "later");
  const reopened = await h.cache.get(r.root);
  expect(reopened.index.complete("secret")).toEqual([]);
  expect(reopened.index.complete("later")).toEqual(["later.ts"]);
  expect(h.inventories).toBe(2);
  expect(h.open).toBe(1);
});

test("a workspace held by an in-flight request outlives its idle deadline", async () => {
  const h = await harness();
  const r = await repo();
  await r.write("held.ts", "held");
  await h.cache.get(r.root);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const request = h.cache.use(r.root, async (workspace) => {
    entered.resolve();
    await release.promise;
    return workspace.index.complete("held");
  });
  await entered.promise;
  await h.timers.pass(idleMs);
  await settle();
  expect(h.open).toBe(1);
  release.resolve();
  expect(await request).toEqual(["held.ts"]);
  // The deadline restarts once the request lets go.
  await h.timers.pass(idleMs);
  await settle();
  expect(h.open).toBe(0);
  expect(h.inventories).toBe(1);
});

test("retiring during an unfinished update drains it and shutdown waits without rearming", async () => {
  const timers = manualTimers();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const r = await repo();
  let open = 0,
    finished = false;
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
          entered.resolve();
          await release.promise;
          await git.update(paths);
          finished = true;
        },
      };
    },
    undefined,
    (root) => {
      const handle = watch(root, { recursive: true });
      open++;
      handle.once("close", () => open--);
      return handle;
    },
    { idleMs, coalesceMs, timers: timers.scheduler },
  );
  cleanups.unshift(() => cache.close());
  await cache.get(r.root);
  await r.write("late.ts", "late");
  await expect.poll(() => timers.armed(coalesceMs), { timeout: 10_000 }).toBe(1);
  void timers.pass(coalesceMs);
  await entered.promise;
  await timers.pass(idleMs);
  let closed = false;
  const closing = cache.close().then(() => {
    closed = true;
  });
  await settle();
  expect(closed).toBe(false);
  release.resolve();
  await closing;
  expect(finished).toBe(true);
  await settle();
  expect(open).toBe(0);
  expect(timers.armed(coalesceMs) + timers.armed(idleMs)).toBe(0);
});

test("closing during a coalescing window cancels it and launches no Git", async () => {
  const h = await harness();
  const r = await repo();
  await h.cache.get(r.root);
  await r.write("a.ts", "a");
  h.launches.length = 0;
  h.hint(r.root, "a.ts");
  expect(h.timers.armed(coalesceMs)).toBe(1);
  await h.cache.close();
  expect(h.timers.armed(coalesceMs)).toBe(0);
  expect(h.launches).toEqual([]);
  await expect(h.cache.get(r.root)).rejects.toMatchObject({ code: "busy" });
});

test("an idle workspace stuck in recovery stops retrying when it retires", async () => {
  const retries = manualTimers();
  const timers = manualTimers();
  const r = await repo();
  await r.write("a.ts", "a");
  let failing = false;
  let source: FSWatcher | undefined;
  const cache = new WorkspaceCache(
    4,
    (root) => {
      const git = new GitWorkspace(root);
      return {
        root,
        get index() {
          return git.index;
        },
        initialize: async () => {
          if (failing) throw new Error("Git temporarily unavailable");
          await git.initialize();
        },
        inspect: (path) => git.inspect(path),
        read: (path, limit) => git.read(path, limit),
        update: (paths) => git.update(paths),
      };
    },
    retries.scheduler,
    (root) => {
      source = watch(root, { recursive: true });
      return source;
    },
    { idleMs, coalesceMs, timers: timers.scheduler },
  );
  cleanups.unshift(() => cache.close());
  await cache.get(r.root);
  failing = true;
  source?.emit("error", new Error("lost watcher"));
  await expect.poll(() => retries.armed(100), { timeout: 10_000 }).toBe(1);
  await timers.pass(idleMs);
  expect(retries.armed(100)).toBe(0);
  failing = false;
  await r.write("b.ts", "b");
  expect((await cache.get(r.root)).index.complete("b.ts")).toEqual(["b.ts"]);
});

/** Indexes of synthetic paths, so byte pressure needs no large repository. */
function syntheticCache(limits: WorkspaceCacheLimits, files: number) {
  const timers = manualTimers();
  const inventories = new Map<string, number>();
  const cache = new WorkspaceCache(
    4,
    (root) => {
      let index = new PathIndex();
      return {
        root,
        get index() {
          return index;
        },
        async initialize() {
          inventories.set(root, (inventories.get(root) ?? 0) + 1);
          const next = new PathIndex();
          for (let i = 0; i < files; i++) next.update(`src/module-${i}.ts`, true);
          index = next;
        },
        inspect: async () => "file" as const,
        read: async () => ({ bytes: Buffer.alloc(0), more: false }),
        update: async () => {},
      };
    },
    undefined,
    (root) => watch(root, { recursive: true }),
    { idleMs, coalesceMs, timers: timers.scheduler, ...limits },
  );
  cleanups.unshift(() => cache.close());
  return { cache, inventories };
}

test("byte pressure retires the least recently used root and keeps completion exact", async () => {
  const roots = [await repo(), await repo(), await repo()].map((value) => value.root);
  const probe = new PathIndex();
  for (let i = 0; i < 2000; i++) probe.update(`src/module-${i}.ts`, true);
  // Room for two of the three indexes.
  const { cache, inventories } = syntheticCache(
    { maxBytes: Math.floor(probe.estimatedBytes * 2.5) },
    2000,
  );
  for (const root of roots) await cache.get(root);
  await cache.get(roots[1] ?? "");
  await cache.get(roots[2] ?? "");
  expect(roots.map((root) => inventories.get(root))).toEqual([1, 1, 1]);
  // The evicted root rebuilds on demand and still answers in full.
  const reopened = await cache.get(roots[0] ?? "");
  expect(reopened.index.complete("module-1999")).toEqual(["src/module-1999.ts"]);
  expect([...reopened.index.under("src")]).toHaveLength(2000);
  expect(roots.map((root) => inventories.get(root))).toEqual([2, 1, 1]);
  // Root 1 is now least recently used and made room for root 0.
  await cache.get(roots[1] ?? "");
  expect(inventories.get(roots[1] ?? "")).toBe(2);
});

test("one root larger than the whole byte budget is kept whole, not truncated", async () => {
  const roots = [await repo(), await repo()].map((value) => value.root);
  const { cache, inventories } = syntheticCache({ maxBytes: 1024 }, 3000);
  const [first, second] = roots;
  if (!first || !second) throw new Error("Expected two roots");
  const large = await cache.get(first);
  expect([...large.index.under("src")]).toHaveLength(3000);
  expect(large.index.complete("module-2999")).toEqual(["src/module-2999.ts"]);
  // A request holding the old root keeps it through pressure from a new one.
  const held = cache.use(first, async (workspace) => {
    await cache.get(second);
    return [...workspace.index.under("src")].length;
  });
  expect(await held).toBe(3000);
  await cache.get(first);
  expect(inventories.get(first)).toBe(1);
  expect(inventories.get(second)).toBe(1);
});
