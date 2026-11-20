import { expect, test } from "vitest";
import type { ProbeLaunch } from "./probe-resolve.ts";
import type { ProbeThread } from "./probe-thread.ts";
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

test("a probe's command lookup and its run share one deadline from the probe's start", async () => {
  // A clock the test moves: each timer fires once its time comes.
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const advance = (to: number) => {
    now = to;
    for (const timer of [...timers])
      if (timer.at <= to) {
        timers.delete(timer);
        timer.run();
      }
  };
  const lookup = Promise.withResolvers<ProbeLaunch>();
  const running = Promise.withResolvers<void>();
  // A probe thread whose process runs until it is stopped.
  const thread: ProbeThread = {
    run: (_request, signal) =>
      new Promise((resolve) => {
        running.resolve();
        signal.addEventListener("abort", () =>
          resolve({ code: null, signal: "SIGKILL", reason: "stopped", stdout: "", stderr: "" }),
        );
      }),
  };
  const probe = probeOutput("tool", ["--version"], {
    timeoutMs: 1_000,
    resolve: () => lookup.promise,
    thread,
    schedule: (callback, ms) => {
      const timer = { at: now + ms, run: callback };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  });
  const failed = expect(probe).rejects.toThrow("Probe timed out");
  // The lookup takes most of the budget; what is left is the run's.
  advance(600);
  lookup.resolve({ command: "/bin/tool", args: ["--version"], env: {} });
  await running.promise;
  advance(1_000);
  await failed;
});
