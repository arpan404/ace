import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { UsageSettings } from "@ace/usage";
import { UsageReplay } from "./usage-replay.ts";
import { createDaemonUsage } from "./usage.ts";

// Non-gating. Times the usage service's start and catch-up against copies of an events and a
// usage database, without opening the daemon Store or any engine: nothing is resumed.
// Run: bun apps/daemon/src/usage-start.bench.ts <events.sqlite> <usage.sqlite> [lag]
// `lag` rewinds the usage cursor by that many events first, as after a crash or a rebuild.
const [eventsPath, usagePath, lagArgument] = process.argv.slice(2);
if (!eventsPath || !usagePath)
  throw new Error("Usage: usage-start.bench.ts <events> <usage> [lag]");
const lag = Number(lagArgument ?? 0);
const root = await mkdtemp(join(tmpdir(), "ace-usage-start-bench-"));
try {
  for (const suffix of ["", "-wal"])
    await copyFile(usagePath + suffix, join(root, `usage.sqlite${suffix}`)).catch(() => {});
  const events = new DatabaseSync(eventsPath);
  const head = Number(events.prepare("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0);
  if (lag > 0) {
    const usage = new DatabaseSync(join(root, "usage.sqlite"));
    usage.prepare("UPDATE usage_meta SET cursor=max(0, cursor-?)").run(lag);
    usage.close();
  }
  const replay = new UsageReplay(events);
  const store = {
    subscribeUsage: () => () => {},
    readUsagePage: (options: { afterSeq: number; limit: number; maxBytes?: number }) =>
      replay.read(options, head),
  };
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  const started = performance.now();
  const usage = createDaemonUsage(
    root,
    store,
    UsageSettings.parse({
      timezone: process.env.TZ_BENCH ?? "America/Chicago",
      fetchPrices: false,
    }),
    (error) => console.error("usage failure", error),
  );
  await usage.start();
  const ready = performance.now() - started;
  await usage.catchUp();
  const caughtUp = performance.now() - started;
  delay.disable();
  console.log(
    JSON.stringify({
      head,
      lag,
      startMs: Math.round(ready),
      catchUpMs: Math.round(caughtUp),
      maxLoopDelayMs: Math.round(delay.max / 1e6),
      p99LoopDelayMs: Math.round(delay.percentile(99) / 1e6),
    }),
  );
  await usage.close();
  events.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
