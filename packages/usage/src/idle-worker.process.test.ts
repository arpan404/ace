import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { UsageWorker } from "./index.ts";

test("closing during idle retirement waits for exit without reopening SQLite", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-close-idle-"));
  let timeout: (() => void) | undefined;
  let opened = false;
  const worker = new UsageWorker(
    join(home, "usage.sqlite"),
    {},
    {
      spawn(url, options) {
        if (opened) throw new Error("Closing restarted the projection");
        opened = true;
        return new Worker(url, options);
      },
      delay(callback) {
        timeout = callback;
        return () => {
          timeout = undefined;
        };
      },
    },
  );
  try {
    expect(await worker.cursor()).toBe(0);
    timeout?.();
    await worker.close();
    await expect(worker.cursor()).rejects.toThrow();
  } finally {
    await worker.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("usage coverage survives idle retirement and a later query reopens the durable projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-idle-"));
  let timeout: (() => void) | undefined;
  const worker = new UsageWorker(
    join(home, "usage.sqlite"),
    {},
    {
      spawn: (url, options) => new Worker(url, options),
      delay(callback) {
        timeout = callback;
        return () => {
          timeout = undefined;
        };
      },
    },
  );
  try {
    expect(await worker.ingest({ afterSeq: 0, throughSeq: 10, events: [] })).toBe(10);
    timeout?.();
    expect(await worker.cursor()).toBe(10);
    expect(await worker.ingest({ afterSeq: 10, throughSeq: 12, events: [] })).toBe(12);
    expect(await worker.cursor()).toBe(12);
  } finally {
    await worker.close();
    await rm(home, { recursive: true, force: true });
  }
});
