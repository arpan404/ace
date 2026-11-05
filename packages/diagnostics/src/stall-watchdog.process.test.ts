import { pbkdf2 } from "node:crypto";
import { expect, test } from "vitest";
import { createStallOperation } from "./stall-operation.ts";
import { busyLoopFor, killedWhileFrozen, watched } from "./stall-watchdog-test-support.ts";

// What the watchdog reports on both runtimes: the daemon runs it on Bun, the desktop main process
// on Electron's Node. Reading the frozen thread's stack works on Node only and is covered by
// stall-watchdog-stacks.process.test.ts.

test("a stall inside a named operation reports that operation and the memory it grew to", async () => {
  const operation = createStallOperation();
  const held: Buffer[] = [];
  const reports = await watched(
    operation.wrap("browser.picture", function freezeWhileAllocating() {
      // Written with non-zero bytes, so every page is resident before the thread spins.
      held.push(Buffer.allocUnsafe(256 * 1024 * 1024).fill(1));
      busyLoopFor(1_500);
    }),
    operation,
  );
  expect(reports).toHaveLength(1);
  const [report] = reports;
  expect(report).toMatchObject({ kind: "main", operation: "browser.picture", ended: true });
  expect(report?.rssBytes).toBeGreaterThan(256 * 1024 * 1024);
  held.length = 0;
});

test("a stall after a named operation finished does not blame that operation", async () => {
  const operation = createStallOperation();
  operation.run("updates.check", () => undefined);
  const reports = await watched(function freezeOutsideOperations() {
    busyLoopFor(1_500);
  }, operation);
  expect(reports).toHaveLength(1);
  expect(reports[0]?.operation).toBeUndefined();
});

test("a thread pool that stops answering while the main thread runs is reported", async () => {
  const pool = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  const started = performance.now();
  await new Promise((resolve) => pbkdf2("calibrate", "salt", 20_000, 32, "sha256", resolve));
  // Enough work queued on the pool to keep every pool thread busy for about 1.5 s.
  const iterations = Math.ceil((20_000 * 400) / Math.max(1, performance.now() - started));
  const reports = await watched(() =>
    Promise.all(
      Array.from(
        { length: pool * 4 },
        () => new Promise((resolve) => pbkdf2("busy", "salt", iterations, 32, "sha256", resolve)),
      ),
    ),
  );
  expect(reports.map((report) => report.kind)).toContain("io");
  const io = reports.find((report) => report.kind === "io");
  expect(io?.ended).toBe(true);
  expect(io?.silentMs).toBeGreaterThanOrEqual(400);
});

test("a run killed while frozen leaves its stall for the next start to report once", async () => {
  const { pid, first, again } = await killedWhileFrozen((recorded) => recorded.kind === "main");
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ pid, kind: "main", ended: false });
  expect(first[0]?.silentMs).toBeGreaterThanOrEqual(400);
  expect(again).toEqual([]);
});
