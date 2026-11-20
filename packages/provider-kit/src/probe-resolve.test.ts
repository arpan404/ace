import { expect, test } from "vitest";
import { probeOutput, stopOwnedGroups } from "./process.ts";

/** A command lookup stuck on a stalled mount: it never answers and ignores its signal. */
const hangs = () => new Promise<never>(() => {});
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work,
    new Promise<"still waiting">((done) => setTimeout(done, ms, "still waiting")),
  ]);

test("a global stop doesn't wait on a probe whose command lookup hangs, and starts nothing", async () => {
  let started = 0;
  const probe = probeOutput("tool", ["--version"], {
    resolve: hangs,
    spawn: () => {
      started++;
      throw new Error("Nothing should start");
    },
  });
  const failed = expect(probe).rejects.toThrow("Probe stopped");
  expect(await within(stopOwnedGroups(0), 2_000)).toBeUndefined();
  await failed;
  expect(started).toBe(0);
});

test("a probe whose command lookup hangs ends at its deadline", async () => {
  const deadlines: (() => void)[] = [];
  const probe = probeOutput("tool", ["--version"], {
    resolve: hangs,
    schedule: (callback) => {
      deadlines.push(callback);
      return () => {};
    },
  });
  const failed = expect(probe).rejects.toThrow("Probe timed out");
  await expect.poll(() => deadlines.length).toBe(1);
  deadlines[0]?.();
  await failed;
});

test("a caller's abort ends a probe whose command lookup hangs", async () => {
  const controller = new AbortController();
  const probe = probeOutput("tool", ["--version"], { resolve: hangs, signal: controller.signal });
  const failed = expect(probe).rejects.toThrow("Probe aborted");
  controller.abort();
  await failed;
});
