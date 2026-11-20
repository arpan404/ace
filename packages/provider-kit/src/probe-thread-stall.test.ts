import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import type { IdleWorkerRuntime, WorkerPort } from "./idle-worker.ts";
import { createProbeThread, stopGraceMs } from "./probe-thread.ts";
import { probeOutput, stopOwnedGroups } from "./process.ts";

/** A worker stuck in a spawn: it reads nothing it is sent, and ends only when terminated. */
class StuckWorker extends EventEmitter implements WorkerPort {
  terminated = false;
  postMessage(): void {}
  async terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 1);
    return 1;
  }
  unref(): void {}
}

/** A probe thread on stuck workers, with its timers held for the test to run. */
function stuckThread() {
  const workers: StuckWorker[] = [];
  const timers = new Set<{ ms: number; run: () => void }>();
  const runtime: IdleWorkerRuntime = {
    spawn: () => {
      const worker = new StuckWorker();
      workers.push(worker);
      return worker;
    },
    delay: (run, ms) => {
      const timer = { ms, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
  };
  /** The stop grace runs out. */
  const graceEnds = () => {
    for (const timer of timers)
      if (timer.ms === stopGraceMs) {
        timers.delete(timer);
        timer.run();
      }
  };
  return {
    thread: createProbeThread(new URL("file:///stuck-worker.ts"), runtime),
    workers,
    graceEnds,
  };
}
const launch = async () => ({ command: "/bin/tool", args: ["--version"], env: {} });

test("a probe whose worker is stuck in its spawn ends at its deadline once the worker is ended", async () => {
  const { thread, workers, graceEnds } = stuckThread();
  let deadline: (() => void) | undefined;
  const probe = probeOutput("tool", ["--version"], {
    resolve: launch,
    thread,
    schedule: (callback) => {
      deadline = callback;
      return () => {};
    },
  });
  const failed = expect(probe).rejects.toThrow("Probe timed out");
  await expect.poll(() => workers.length).toBe(1);
  deadline?.();
  // The stop it is sent goes unread; past the grace the worker itself is ended.
  expect(workers[0]?.terminated).toBe(false);
  graceEnds();
  await failed;
  expect(workers[0]?.terminated).toBe(true);
});

test("a global stop doesn't wait forever on a probe whose worker is stuck in its spawn", async () => {
  const { thread, workers, graceEnds } = stuckThread();
  const probe = probeOutput("tool", ["--version"], { resolve: launch, thread });
  void probe.catch(() => {});
  await expect.poll(() => workers.length).toBe(1);
  const stopped = stopOwnedGroups(0);
  graceEnds();
  await expect(stopped).resolves.toBeUndefined();
  await expect(probe).rejects.toThrow();
});
