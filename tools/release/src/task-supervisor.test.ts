import { expect, test } from "vitest";
import { untilCleanExit } from "./runtime.ts";

// The Windows task's supervisor loop: Task Scheduler never restarts a task that has ended.
const windows = test.runIf(process.platform === "win32");

windows("a failing supervisor is retried with backoff until it exits cleanly", async () => {
  const outcomes: (() => number | undefined)[] = [
    () => {
      throw new Error("No release installed");
    },
    () => {
      throw new Error("No release installed");
    },
    () => 1,
    () => {
      throw new Error("Home is busy");
    },
    () => 0,
  ];
  const waits: number[] = [];
  let runs = 0;
  await untilCleanExit({
    once: async () => outcomes[runs++]?.(),
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  expect(runs).toBe(5);
  // Backoff grows while the supervisor keeps failing and starts over once it ran a daemon.
  expect(waits).toEqual([1000, 2000, 15_000, 1000]);
});
