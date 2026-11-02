import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { createStallOperation } from "@ace/diagnostics/stall";
import { expect, test } from "vitest";
import { stallWorkerUrl, watchFreezes } from "./freeze-watch.ts";

/** A watchdog thread that never starts, so only the start-up report is exercised. */
const idleWorker = () =>
  Object.assign(new EventEmitter(), {
    unref() {},
    terminate: async () => 0,
  }) as unknown as Worker;

test("a run force-quit while frozen is reported at the next start, with its operation and memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "freeze-watch-"));
  try {
    writeFileSync(
      join(directory, "stall-4242.json"),
      JSON.stringify({
        pid: 4242,
        kind: "main",
        silentSince: Date.parse("2026-11-02T02:49:12Z"),
        silentMs: 94_000,
        caught: false,
        stack: [],
        ended: false,
        rssBytes: 3_849_000_000,
        operation: "browser reply Accessibility.getFullAXTree",
      }),
    );
    const records: { message: string; data?: Record<string, unknown> }[] = [];
    const stop = watchFreezes({
      log: (_level, message, data) => records.push({ message, ...(data ? { data } : {}) }),
      directory,
      pid: 5151,
      operation: createStallOperation(),
      spawn: idleWorker,
    });
    await stop();
    expect(records).toEqual([
      {
        message: "The app's main process froze before it last closed",
        data: expect.objectContaining({
          previousPid: 4242,
          frozenSince: "2026-11-02T02:49:12.000Z",
          silentMs: 94_000,
          rssBytes: 3_849_000_000,
          operation: "browser reply Accessibility.getFullAXTree",
        }),
      },
    ]);
    // Reported once: the next start finds nothing.
    records.length = 0;
    await watchFreezes({
      log: (_level, message) => records.push({ message }),
      directory,
      pid: 6161,
      operation: createStallOperation(),
      spawn: idleWorker,
    })();
    expect(records).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  [
    "file:///Applications/ace.app/Contents/Resources/app.asar/main.mjs",
    "file:///Applications/ace.app/Contents/Resources/app.asar.unpacked/stall-watchdog-worker.mjs",
  ],
  [
    "file:///repo/apps/desktop/dist/dev/main.mjs",
    "file:///repo/apps/desktop/dist/dev/stall-watchdog-worker.mjs",
  ],
])("the watchdog thread loads beside %s, outside any asar archive", (main, worker) => {
  expect(stallWorkerUrl(main).href).toBe(worker);
});
