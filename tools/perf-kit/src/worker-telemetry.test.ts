import { expect, test } from "vitest";
import { liveWorkerTelemetry, readWorkerSnapshot } from "@ace/perf-kit";

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

test("a missing root cannot turn worker telemetry into a valid process sample", () => {
  expect(() => liveWorkerTelemetry([{ threadId: 1, workerIds: [] }])).toThrow("Missing main");
});

test.each([
  {
    samples: [
      { threadId: 0, workerIds: [1, 1] },
      { threadId: 1, workerIds: [] },
    ],
  },
  {
    samples: [
      { threadId: 0, workerIds: [] },
      { threadId: 0, workerIds: [] },
    ],
  },
])("duplicate worker ownership or isolate samples cannot produce a worker count", ({ samples }) => {
  expect(() => liveWorkerTelemetry(samples)).toThrow("Invalid worker telemetry");
});

test("an acknowledged worker with permanently missing telemetry still fails", async () => {
  let time = 0;
  await expect(
    readWorkerSnapshot({
      read: async (id) => {
        if (id !== 0) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { threadId: 0, workerIds: [1], pendingWorkerIds: [], generation: 0 };
      },
      now: () => time,
      pause: async () => {
        time += 10;
        if (time > 100) throw new Error("Sampler ignored its deadline");
      },
      timeoutMs: 20,
    }),
  ).rejects.toThrow("missing");
});

test("initialization cannot silently omit a worker or wait past its sampling deadline", async () => {
  let time = 0;
  await expect(
    readWorkerSnapshot({
      read: async () => ({ threadId: 0, workerIds: [], pendingWorkerIds: [1], generation: 0 }),
      now: () => time,
      pause: async () => {
        time += 10;
        if (time > 100) throw new Error("Sampler ignored its deadline");
      },
      timeoutMs: 20,
    }),
  ).rejects.toThrow("Worker telemetry did not stabilize");
});
