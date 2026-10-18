// Resource benchmark for context file indexes (issue #964). Uses temp repos only.
// Run: node --expose-gc bench/index-resources.ts [path-to-context-index.ts]
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { spawnRawSupervised } from "@ace/provider-kit/process";

type Context = typeof import("../src/index.ts");
const source = process.argv[2] ?? "../src/index.ts";
const context: Context = await import(source);
const { GitWorkspace, PathIndex, WorkspaceCache } = context;
const run = promisify(execFile);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("Run with --expose-gc");
const temporary: string[] = [];

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-index-bench-")));
  temporary.push(root);
  await run("git", ["init", "--quiet", root]);
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/main.ts"), "main");
  return root;
}
function counted(counts: Map<string, number>) {
  return {
    spawn(options: Parameters<typeof spawnRawSupervised>[0]) {
      const args = options.args ?? [];
      const command = args.find((arg) => arg === "ls-files" || arg === "check-ignore") ?? "other";
      counts.set(command, (counts.get(command) ?? 0) + 1);
      return spawnRawSupervised(options);
    },
  };
}
function syntheticPaths(count: number, seed: number): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `packages/pkg-${seed}-${Math.floor(i / 400)}/src/components/feature-${Math.floor(i / 40)}/Component${i}View.tsx`,
  );
}
function heap(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
}
const mib = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;

async function directHints() {
  const root = await repository();
  const counts = new Map<string, number>();
  const workspace = new GitWorkspace(root, 100_000, counted(counts));
  await workspace.initialize();
  await mkdir(join(root, "dist"));
  const files = Array.from({ length: 100 }, (_, i) => `dist/out-${i}.js`);
  for (const file of files) await writeFile(join(root, file), "built");
  const folders = Array.from({ length: 10 }, (_, i) => `feature-${i}`);
  for (const folder of folders) await mkdir(join(root, folder));
  for (const folder of folders) await writeFile(join(root, folder, "index.ts"), "x");
  counts.clear();
  await workspace.update(files);
  const ignoredFiles = Object.fromEntries(counts);
  counts.clear();
  await workspace.update(folders);
  const changedFolders = Object.fromEntries(counts);
  return { ignoredFiles100: ignoredFiles, changedFolders10: changedFolders };
}

async function churn(idleMs: number | undefined) {
  const root = await repository();
  const counts = new Map<string, number>();
  const cache = new WorkspaceCache(
    4,
    (workspaceRoot) => new GitWorkspace(workspaceRoot, 100_000, counted(counts)),
    undefined,
    undefined,
    idleMs === undefined ? {} : { idleMs },
  );
  try {
    await cache.get(root);
    if (idleMs !== undefined) await delay(idleMs + 500);
    await mkdir(join(root, "dist"));
    counts.clear();
    const cpu = process.cpuUsage();
    const started = performance.now();
    // A separate "build" process writes 20 ignored outputs every 100 ms for
    // five seconds, so this process's CPU is only the cache's own work.
    await run(process.execPath, [
      "-e",
      `const fs=require("node:fs"),p=require("node:path");let t=0;const i=setInterval(()=>{for(let k=0;k<20;k++)fs.writeFileSync(p.join(process.argv[1],"chunk-"+t+"-"+k+".js"),"built");if(++t===50)clearInterval(i)},100);`,
      join(root, "dist"),
    ]);
    await delay(1000);
    const used = process.cpuUsage(cpu);
    const elapsed = performance.now() - started;
    return {
      hints: 1000,
      spawns: Object.fromEntries(counts),
      daemonCpuPercent: Math.round(((used.user + used.system) / 1000 / elapsed) * 1000) / 10,
    };
  } finally {
    await cache.close();
  }
}

function retainedIndexes() {
  const before = heap();
  const kept: InstanceType<typeof PathIndex>[] = [];
  for (let seed = 0; seed < 4; seed++) {
    const index = new PathIndex(1_000_000);
    for (const path of syntheticPaths(80_000, seed)) index.update(path, true);
    kept.push(index);
  }
  const retained = heap() - before;
  const estimated = kept.reduce(
    (sum, index) => sum + ((index as { estimatedBytes?: number }).estimatedBytes ?? 0),
    0,
  );
  const started = performance.now();
  for (let i = 0; i < 200; i++) kept[0]?.complete(["c12v", "pkg0", "", "feature-19"][i % 4] ?? "");
  const completionUs = Math.round(((performance.now() - started) * 1000) / 200);
  kept.length = 0;
  return { retainedMiB: mib(retained), estimatedMiB: mib(estimated), completionUs };
}

async function cacheAcrossRoots() {
  const roots: string[] = [];
  for (let i = 0; i < 4; i++) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-index-root-")));
    temporary.push(root);
    roots.push(root);
  }
  const before = heap();
  const cache = new WorkspaceCache(4, (root) => {
    let index = new PathIndex(1_000_000);
    const seed = roots.indexOf(root);
    return {
      root,
      get index() {
        return index;
      },
      async initialize() {
        const next = new PathIndex(1_000_000);
        for (const path of syntheticPaths(80_000, seed)) next.update(path, true);
        index = next;
      },
      inspect: async () => "file" as const,
      read: async () => ({ bytes: Buffer.alloc(0), more: false }),
      update: async () => {},
    };
  });
  try {
    for (const root of roots) await cache.get(root);
    // Let closed watcher handles finish closing before measuring.
    await delay(50);
    const retained = heap() - before;
    const newest = (await cache.get(roots[3] ?? "")).index.complete("c79999v");
    return {
      roots: 4,
      filesPerRoot: 80_000,
      retainedMiB: mib(retained),
      newestCompletions: newest.length,
    };
  } finally {
    await cache.close();
  }
}

try {
  const result = {
    source,
    hints: await directHints(),
    churnWhileOpen: await churn(undefined),
    churnAfterIdle: await churn(1000),
    indexes: retainedIndexes(),
    cache: await cacheAcrossRoots(),
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const root of temporary) await rm(root, { recursive: true, force: true });
}
