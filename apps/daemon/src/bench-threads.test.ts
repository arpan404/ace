import { expect, test } from "vitest";
import {
  runtimeThreadCeiling,
  threadViolations,
  workerKind,
  type ThreadLimits,
} from "../bench/budgets.ts";
import { classifyThreads, sampledThreadNames } from "../bench/threads.ts";

/** Thread headings as macOS `sample` prints them for a Bun daemon (one per thread). */
const report = `Call graph:
    688 Thread_67902904   DispatchQueue_1: com.apple.main-thread  (serial)
    + 688 start  (in dyld) + 7184  [0x18d2a3da4]
    688 Thread_67902976: Bun Pool 0
    688 Thread_67902977: mi-scavenger
    688 Thread_67902980: JIT Worklist Helper Thread
    688 Thread_67902988: JSCWarmUp
    688 Thread_67903080: Heap Helper Thread
    688 Thread_67903255
    688 Thread_67903256: Worker
    688 Thread_67903307: CFThreadLoop
    688 Thread_67903388: JSC Heap Collector Thread
    688 Thread_67904319: JSC VMTraps Signal Sender
`;

test("a sampled Bun daemon's threads split into the runtime's, its JS workers and its own", () => {
  expect(classifyThreads(sampledThreadNames(report))).toEqual({
    total: 11,
    runtime: 7,
    workers: 1,
    // The main thread, the unnamed native thread and the file watcher's run loop.
    own: 3,
  });
});

test("Linux's 15-character thread names classify as the full names do", () => {
  expect(
    classifyThreads([
      "bun",
      "Bun Pool 12",
      "Heap Helper Thr",
      "JIT Worklist He",
      "JSC Heap Collec",
      "Worker",
    ]),
  ).toEqual({ total: 6, runtime: 4, workers: 1, own: 1 });
});

const limits: ThreadLimits = {
  idleWorkers: 1,
  activeWorkers: 4,
  settledWorkers: ["stall-watchdog-worker", "notification-worker"],
  idleOwnThreads: 4,
  activeOwnThreads: 5,
  runtimeThreads: runtimeThreadCeiling(16),
};
/** A sample in which telemetry saw every worker the OS runs, of these kinds. */
const sample = (
  census: { runtime?: number; workers?: number; own?: number },
  floor = 1,
  kinds: (string | undefined)[] = ["stall-watchdog-worker"],
) => {
  const { runtime = 29, workers = kinds.length, own = 3 } = census;
  return {
    census: { total: runtime + workers + own, runtime, workers, own },
    workers: Array.from({ length: workers }, (_, index) => ({ kind: kinds[index] })),
    workerFloor: floor,
  };
};
const healthy = {
  idle: sample({}),
  active: sample({ workers: 3 }),
  settled: sample({}, 1, ["stall-watchdog-worker", "notification-worker"]),
};

test("a daemon within every thread budget passes", () => {
  expect(threadViolations(healthy, limits)).toEqual([]);
});

test("a native thread too many of the daemon's own fails the gate, idle or active", () => {
  expect(
    threadViolations({ ...healthy, idle: sample({ own: 5 }), active: sample({ own: 6 }) }, limits),
  ).toEqual(["idle daemon threads: 5 exceeds 4", "active daemon threads: 6 exceeds 5"]);
});

test("a worker alive in one idle reading but retired in another doesn't count against the budget", () => {
  expect(threadViolations({ ...healthy, idle: sample({ workers: 2 }, 1) }, limits)).toEqual([]);
});

test("more workers than the workload's budget fails the gate", () => {
  expect(threadViolations({ ...healthy, active: sample({ workers: 5 }) }, limits)).toEqual([
    "active JS workers: 5 exceeds 4",
  ]);
});

test("a worker of a kind no service accounts for, alive after the workload, fails the gate", () => {
  const settled = sample({}, 1, ["stall-watchdog-worker", "notification-worker", "query-worker"]);
  expect(threadViolations({ ...healthy, settled }, limits)).toEqual([
    "JS workers after the workload: query-worker still alive",
  ]);
});

test("a second worker of an allowed kind after the workload fails the gate", () => {
  const settled = sample({}, 1, [
    "stall-watchdog-worker",
    "notification-worker",
    "notification-worker",
  ]);
  expect(threadViolations({ ...healthy, settled }, limits)).toEqual([
    "JS workers after the workload: 2 notification-worker workers still alive",
  ]);
});

test("a worker after the workload whose module nobody announced is not measured, never allowed", () => {
  const settled = sample({}, 1, ["stall-watchdog-worker", undefined]);
  expect(threadViolations({ ...healthy, settled }, limits)).toEqual([
    "settled JS workers: not measured (1 of no known module)",
  ]);
});

test("a worker's kind is its module's name, bundled or from source", () => {
  expect(workerKind("file:///app/daemon/notification-worker.mjs")).toBe("notification-worker");
  expect(workerKind("/repo/packages/diagnostics/src/stall-watchdog-worker.ts")).toBe(
    "stall-watchdog-worker",
  );
  expect(workerKind(undefined)).toBeUndefined();
});

test("a runaway Bun thread pool fails the gate, while the pool's usual size passes", () => {
  const busy = { ...healthy, active: sample({ runtime: 48, workers: 3 }) };
  expect(threadViolations(busy, limits)).toEqual([]);
  expect(
    threadViolations({ ...busy, active: sample({ runtime: 49, workers: 3 }) }, limits),
  ).toEqual(["active Bun runtime threads: 49 exceeds 48"]);
});
