import { performance } from "node:perf_hooks";
import { SettingsService, type FileIO, type Scheduler } from "../src/index.ts";

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
  document = JSON.stringify({ version: 2, settings: { "future.payload": "x".repeat(16384) } });
  await measure("external reconciliation, 16 KiB", 1000, async () => {
    await service.refresh({ kind: "global" });
  });
  console.log(JSON.stringify({ deliveries, peakRssKiB: process.resourceUsage().maxRSS }));
} finally {
  await service.close();
}
