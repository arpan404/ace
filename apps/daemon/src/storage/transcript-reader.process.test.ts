import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { StorageInventory } from "./inventory.ts";
import { storageFixture } from "./test-support.ts";
import type { TranscriptReaderOptions } from "./transcript-reader.ts";

const fixtures: Awaited<ReturnType<typeof storageFixture>>[] = [];
const inventories: StorageInventory[] = [];
afterEach(async () => {
  for (const inventory of inventories.splice(0)) await inventory.close();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

const reply = `process.on("message", (message) => {
  if (message && message.op === "transcripts")
    process.send({ kind: "transcripts", bytes: message.threads.map(() => 11) });
});`;

/** A process boundary whose children run the given script instead of the real worker. */
function spawnWorkers(script: string) {
  const workers: ChildProcess[] = [];
  return {
    workers,
    spawn() {
      const worker = spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      workers.push(worker);
      return worker;
    },
  };
}

/** A killed worker whose exit and close events never reach the reader. */
function withheldExitWorkers(script: string) {
  const tracking = spawnWorkers(script);
  let notifyExit: (() => void) | undefined;
  return {
    workers: tracking.workers,
    spawn() {
      const worker = tracking.spawn();
      if (tracking.workers.length === 1) {
        const emit = worker.emit.bind(worker);
        let withholding = true;
        Object.defineProperty(worker, "emit", {
          value(event: string | symbol, ...args: unknown[]) {
            if (withholding && (event === "exit" || event === "close")) return true;
            return emit(event, ...args);
          },
        });
        notifyExit = () => {
          withholding = false;
          worker.emit("exit", null, "SIGKILL");
        };
      }
      return worker;
    },
    notifyExit() {
      notifyExit?.();
    },
  };
}

function inventoryFor(
  f: Awaited<ReturnType<typeof storageFixture>>,
  transcripts: TranscriptReaderOptions,
) {
  const inventory = new StorageInventory(
    { root: f.root, now: f.now, id: () => "inventory", store: f.store, services: f.services },
    transcripts,
  );
  inventories.push(inventory);
  return inventory;
}

/** Closing an inventory twice is not idempotent, so a test that closes one owns that close. */
function closeInventory(inventory: StorageInventory): Promise<void> {
  const index = inventories.indexOf(inventory);
  if (index !== -1) inventories.splice(index, 1);
  return inventory.close();
}

test("a concurrent read waits for the one in flight instead of failing", async () => {
  const f = await storageFixture();
  fixtures.push(f);
  const tracking = spawnWorkers(reply);
  const inventory = inventoryFor(f, { spawn: tracking.spawn });
  const first = f.thread("first").id;
  const second = f.thread("second").id;
  const measured = await Promise.all([inventory.thread(first), inventory.thread(second)]);
  expect(measured.map((candidate) => candidate?.bytes)).toEqual([11, 11]);
  expect(tracking.workers).toHaveLength(1);
});

test("a stalled single-thread recheck fails at its short deadline", async () => {
  const f = await storageFixture();
  fixtures.push(f);
  const tracking = spawnWorkers("process.on('message', () => {}); setInterval(() => {}, 1000);");
  const inventory = inventoryFor(f, {
    spawn: tracking.spawn,
    limits: { recheckMs: 80, batchMs: 60_000, perThreadMs: 1, reapMs: 500 },
  });
  const started = performance.now();
  await expect(inventory.thread(f.thread("stalled").id)).rejects.toThrow("storage_usage_timeout");
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a batch deadline scales with its thread count and frees the serializer", async () => {
  const f = await storageFixture();
  fixtures.push(f);
  for (const title of ["one", "two", "three"]) f.thread(title);
  const tracking = spawnWorkers("process.on('message', () => {}); setInterval(() => {}, 1000);");
  const inventory = inventoryFor(f, {
    spawn: tracking.spawn,
    limits: { recheckMs: 60_000, batchMs: 40, perThreadMs: 10, reapMs: 500 },
  });
  const started = performance.now();
  await expect(inventory.scan(new Set(["threads"]))).rejects.toThrow("storage_usage_timeout");
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a never-replying worker leaves the event loop free and close finishes promptly", async () => {
  const f = await storageFixture();
  fixtures.push(f);
  const tracking = spawnWorkers("process.on('message', () => {}); setInterval(() => {}, 1000);");
  const inventory = inventoryFor(f, {
    spawn: tracking.spawn,
    limits: { recheckMs: 60_000, batchMs: 60_000, perThreadMs: 1, reapMs: 200 },
  });
  const reading = inventory.thread(f.thread("stuck").id);
  const cancelled = expect(reading).rejects.toThrow("storage_usage_cancelled");
  await new Promise((resolve) => setTimeout(resolve, 30));
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 5);
  await new Promise((resolve) => setTimeout(resolve, 40));
  clearInterval(heartbeat);
  expect(ticks).toBeGreaterThan(1);
  const started = performance.now();
  await closeInventory(inventory);
  await cancelled;
  expect(performance.now() - started).toBeLessThan(1500);
  expect(tracking.workers[0]?.signalCode).toBe("SIGKILL");
});

test("close reports a cleanup timeout when a killed worker never reports exit", async () => {
  const f = await storageFixture();
  fixtures.push(f);
  const tracking = withheldExitWorkers(
    "process.on('message', () => {}); setInterval(() => {}, 1000);",
  );
  const inventory = inventoryFor(f, {
    spawn: tracking.spawn,
    limits: { recheckMs: 60_000, batchMs: 60_000, perThreadMs: 1, reapMs: 120 },
  });
  const reading = inventory.thread(f.thread("stuck").id);
  const cancelled = expect(reading).rejects.toThrow("storage_usage_cancelled");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const started = performance.now();
  await expect(closeInventory(inventory)).rejects.toThrow("storage_usage_cleanup_timeout");
  await cancelled;
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(100);
  expect(elapsed).toBeLessThan(2000);
  tracking.notifyExit();
});
