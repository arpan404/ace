import { expect, test } from "vitest";
import { threadViolations } from "../bench/budgets.ts";
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

const withOwnThreads = (own: number) => ({
  census: { total: own + 30, runtime: 29, workers: 1, own },
  workers: [{}],
  workerFloor: 1,
});

test("a native thread too many of the daemon's own fails the gate, idle or active", () => {
  const sample = withOwnThreads;
  const limits = { idleWorkers: 1, idleOwnThreads: 4, activeOwnThreads: 5 };
  expect(threadViolations(sample(4), sample(5), limits)).toEqual([]);
  expect(threadViolations(sample(5), sample(6), limits)).toEqual([
    "idle daemon threads: 5 exceeds 4",
    "active daemon threads: 6 exceeds 5",
  ]);
});

test("a worker alive in one reading but retired in another doesn't count against the idle budget", () => {
  // Two workers at the census, but only one survived every idle reading.
  const idle = {
    census: { total: 34, runtime: 29, workers: 2, own: 3 },
    workers: [{}, {}],
    workerFloor: 1,
  };
  expect(
    threadViolations(idle, idle, { idleWorkers: 1, idleOwnThreads: 4, activeOwnThreads: 5 }),
  ).toEqual([]);
});
