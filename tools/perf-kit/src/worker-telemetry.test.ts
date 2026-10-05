import { expect, test } from "vitest";
import { liveWorkerTelemetry } from "@ace/perf-kit";

test("nested live workers count while unreferenced retired files do not", () => {
  const sample = liveWorkerTelemetry([
    { threadId: 0, workerIds: [1] },
    { threadId: 1, workerIds: [3] },
    { threadId: 2, workerIds: [4] },
    { threadId: 3, workerIds: [] },
    { threadId: 4, workerIds: [] },
  ]);
  expect(sample.workers.map((worker) => worker.threadId)).toEqual([1, 3]);
});

test("missing telemetry cannot silently lower the live worker count", () => {
  expect(() => liveWorkerTelemetry([{ threadId: 0, workerIds: [1] }])).toThrow(
    "Missing live worker telemetry: 1",
  );
});
