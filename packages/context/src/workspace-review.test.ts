import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitWorkspace, WorkspaceCache, type WorkspaceFiles } from "./index.ts";
import { spawnSupervisedStream } from "@ace/provider-kit/process";
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
      spawnSupervisedStream({
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
      const child = spawnSupervisedStream({
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
