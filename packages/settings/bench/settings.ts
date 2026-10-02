import { mkdir, mkdtemp, readdir, rename, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  SettingsService,
  SettingsError,
  atomicWrite,
  fileIO,
  type FileIO,
  type Scheduler,
} from "../src/index.ts";

// In-memory filesystem boundary isolates schema, queue and notification costs.
// Production fsync/rename latency depends on the user's disk.
let document = '{"version":2,"settings":{}}';
let changed: () => void = () => {};
let timer: (() => void) | undefined;
const io: FileIO = {
  async read() {
    return document;
  },
  async write(_path, text) {
    document = text;
  },
  async watch(_path, callback) {
    changed = callback;
    return () => {};
  },
};
const scheduler: Scheduler = {
  schedule(callback) {
    timer = callback;
    return () => {
      timer = undefined;
    };
  },
};
const service = new SettingsService({ dataDir: "/benchmark", io, scheduler });
async function measure(name: string, count: number, operation: (index: number) => Promise<void>) {
  const start = performance.now();
  for (let index = 0; index < count; index++) await operation(index);
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      name,
      operations: count,
      opsPerSecond: Math.round((count / elapsed) * 1000),
      microsecondsPerOp: +((elapsed / count) * 1000).toFixed(2),
      peakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
}
try {
  await service.get("notifications.sound");
  await measure("cached get", 100_000, async () => {
    await service.get("notifications.sound");
  });
  await measure("assignment, zero subscribers", 3000, async (index) => {
    await service.set("notifications.sound", index % 2 === 0, { kind: "global" });
  });
  for (let index = 0; index < 1023; index++)
    await service.subscribe({ keys: ["remote.enabled"], scope: {} }, () => {});
  let deliveries = 0;
  await service.subscribe({ keys: ["notifications.sound"], scope: {} }, () => {
    deliveries++;
  });
  await measure("assignment, 1023 unrelated and one affected subscriber", 3000, async (index) => {
    await service.set("notifications.sound", index % 2 === 0, { kind: "global" });
  });
  await measure("watcher burst scheduling", 100_000, async () => {
    changed();
  });
  timer?.();
  await service.refresh({ kind: "global" });
  const payload = "x".repeat(16384);
  await measure("changed external reconciliation, 16 KiB", 1000, async (index) => {
    document = JSON.stringify({
      version: 2,
      settings: { "future.payload": payload, "future.revision": index },
    });
    await service.refresh({ kind: "global" });
  });
  for (const kib of [0, 16, 256, 879]) {
    document = JSON.stringify({
      version: 2,
      settings: { "notifications.sound": false, "future.payload": "x".repeat(kib * 1024) },
    });
    await service.refresh({ kind: "global" });
    await measure(
      `existing scalar assignment, ${kib} KiB unrelated payload`,
      1000,
      async (index) => {
        await service.set("notifications.sound", index % 2 === 0, { kind: "global" });
      },
    );
  }
  document = JSON.stringify({
    version: 2,
    settings: {
      ...Object.fromEntries(
        Array.from({ length: 10000 }, (_, index) => [`future.${index}`, index]),
      ),
      "notifications.sound": false,
    },
  });
  await service.refresh({ kind: "global" });
  await measure("existing scalar assignment, 10000 unrelated keys", 1000, async (index) => {
    await service.set("notifications.sound", index % 2 === 0, { kind: "global" });
  });
  console.log(JSON.stringify({ deliveries, peakRssKiB: process.resourceUsage().maxRSS }));
} finally {
  await service.close();
}

// Real filesystem work includes identity validation and physical durability latency.
const root = await mkdtemp(join(tmpdir(), "ace-settings-bench-"));
const workspace = join(root, "repo");
const dataDir = join(root, "data");
const ace = join(workspace, ".ace");
const displaced = join(workspace, "old-ace");
const workspacePath = join(ace, "settings.json");
let swap = false;
await mkdir(workspace);
const native = new SettingsService({
  dataDir,
  io: {
    ...fileIO,
    watch: async () => () => {},
    write: (path, text, beforeCommit) =>
      atomicWrite(path, text, async () => {
        if (swap && path === workspacePath) {
          await rename(ace, displaced);
          await symlink(dataDir, ace, "dir");
        }
        await beforeCommit?.();
      }),
  },
});
try {
  await native.set("notifications.sound", false, { kind: "global" });
  await native.set("notifications.sound", false, { kind: "workspace", workspace });
  await measure("native cached workspace read with containment", 1000, async () => {
    await native.get("notifications.sound", { workspace });
  });
  await measure("native workspace scalar assignment and fsync", 100, async (index) => {
    await native.set("notifications.sound", index % 2 === 0, { kind: "workspace", workspace });
  });
  swap = true;
  await measure("native rejected directory swap and owned-temp recovery", 32, async () => {
    let rejected = false;
    try {
      await native.set("notifications.sound", true, { kind: "workspace", workspace });
    } catch (error) {
      if (!(error instanceof SettingsError && error.code === "validation")) throw error;
      rejected = true;
    } finally {
      await unlink(ace);
      await rename(displaced, ace);
    }
    if (!rejected || (await readdir(ace)).some((name) => name.endsWith(".tmp")))
      throw new Error("Rejected workspace assignment did not clean its owned temporary file");
    await native.refresh({ kind: "workspace", workspace });
  });
} finally {
  await native.close();
  await rm(root, { recursive: true, force: true });
}
