import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { Store } from "../store.ts";
import { UsageScanner } from "./usage-scanner.ts";

// Non-gating, temporary fixture only. Run: node apps/daemon/src/storage/usage-worker.bench.ts
// Each directory stays below the shared native listing cap. Fixture writes use concurrency 2.
const root = await mkdtemp(join(tmpdir(), "ace-usage-bench-"));
const scanner = new UsageScanner(root);
try {
  const store = new Store(join(root, "events.sqlite"));
  await store.close();
  for (let group = 0; group < 20; group++) {
    const directory = join(root, "logs", String(group));
    await mkdir(directory, { recursive: true });
    for (let file = 0; file < 1000; file += 2) {
      await Promise.all(
        [0, 1].map((offset) => writeFile(join(directory, String(file + offset)), "x".repeat(128))),
      );
    }
  }
  const delay = monitorEventLoopDelay({ resolution: 5 });
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 5);
  delay.enable();
  const started = performance.now();
  const usage = await scanner.scan();
  const scanMs = performance.now() - started;
  delay.disable();
  clearInterval(heartbeat);
  const controller = new AbortController();
  const pending = scanner.scan(controller.signal).then(
    () => "completed",
    () => "cancelled",
  );
  // Choose a cancellation delay from the first scan's observed duration.
  await pause(Math.min(1000, scanMs / 2));
  const cancelledAt = performance.now();
  controller.abort();
  const cancellation = await pending;
  console.log(
    JSON.stringify(
      {
        files: 20_000,
        scanMs: Math.round(scanMs),
        complete: usage.complete,
        logBytes: usage.categories.find((entry) => entry.kind === "logs")?.bytes,
        heartbeatTicks: ticks,
        mainLoopP99Ms: Number((delay.percentile(99) / 1e6).toFixed(2)),
        mainLoopMaxMs: Number((delay.max / 1e6).toFixed(2)),
        cancellation,
        cancellationMs: Math.round(performance.now() - cancelledAt),
      },
      null,
      2,
    ),
  );
} finally {
  await scanner.close();
  await rm(root, { recursive: true, force: true });
}
