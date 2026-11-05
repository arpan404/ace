import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { readWorkerSnapshot } from "@ace/perf-kit";
import { workerPreloadVariable } from "@ace/provider-kit/worker";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { observedWorkers, threadViolations, type ThreadLimits } from "../bench/budgets.ts";
import { Telemetry } from "../bench/telemetry-schema.ts";
import { threadCensus } from "../bench/threads.ts";

/**
 * The perf gate's worker budget on Bun, from the same pieces the gate uses: the telemetry
 * preload, the OS thread census and the budget rules, around a stand-in daemon
 * (bench/fixtures/worker-daemon.ts) that keeps the workers it is told to start.
 */
const bench = join(import.meta.dirname, "../bench");
const limits: ThreadLimits = {
  idleWorkers: 1,
  activeWorkers: 4,
  settledWorkers: ["worker-idle"],
  idleOwnThreads: 4,
  activeOwnThreads: 5,
  runtimeThreads: 48,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The stand-in daemon, observed as the gate observes the real one. */
async function standIn(options: { workers: number; observed: boolean }) {
  const telemetry = await mkdtemp(join(tmpdir(), "ace-worker-budget-"));
  const child = fork(
    join(bench, "fixtures/worker-daemon.ts"),
    Array.from({ length: options.workers }, () => "clean"),
    {
      execPath: bunBinary(),
      execArgv: ["--import", join(bench, "telemetry.mjs")],
      env: {
        ...process.env,
        BUN_OPTIONS: undefined,
        ACE_PERF_TELEMETRY: telemetry,
        [workerPreloadVariable]: options.observed ? join(bench, "telemetry.mjs") : undefined,
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exited = once(child, "exit");
  cleanups.push(async () => {
    child.kill("SIGKILL");
    await exited;
    await rm(telemetry, { recursive: true, force: true });
  });
  await once(child, "message");
  const pid = child.pid;
  if (pid === undefined) throw new Error("The stand-in daemon has no process");
  const telemetryWorkers = async () => {
    const { main, workers } = await readWorkerSnapshot({
      read: async (id) =>
        Telemetry.parse(JSON.parse(await readFile(join(telemetry, `${id}.json`), "utf8"))),
      now: () => performance.now(),
      pause: () => delay(10),
      timeoutMs: 4000,
    });
    return observedWorkers(main, workers);
  };
  return {
    /** Telemetry's workers and the OS census, with the fewest workers seen across readings. */
    async sample(readings = 1) {
      let floor = Infinity;
      for (let reading = 0; reading < readings; reading++)
        floor = Math.min(floor, (await telemetryWorkers()).length);
      const workers = await telemetryWorkers();
      return {
        census: await threadCensus(pid),
        workers,
        workerFloor: Math.min(floor, workers.length),
      };
    },
    async request(message: object) {
      const replied = once(child, "message");
      child.send(message);
      await replied;
    },
  };
}

async function idleViolations(options: { workers: number; observed: boolean }) {
  const sample = await (await standIn(options)).sample();
  return threadViolations({ idle: sample, active: sample, settled: sample }, limits);
}

test("one long-lived worker fits the idle budget", async () => {
  expect(await idleViolations({ workers: 1, observed: true })).toEqual([]);
});

test("one more long-lived worker than the idle budget fails the gate", async () => {
  expect(await idleViolations({ workers: 2, observed: true })).toEqual([
    "idle JS workers: 2 exceeds 1",
    "JS workers after the workload: 2 worker-idle workers still alive",
  ]);
});

test("workers no telemetry is attached to fail the gate as not measured, never as zero", async () => {
  expect(await idleViolations({ workers: 1, observed: false })).toEqual([
    "idle JS workers: not measured (1 running, telemetry saw 0)",
    "active JS workers: not measured (1 running, telemetry saw 0)",
    "settled JS workers: not measured (1 running, telemetry saw 0)",
  ]);
});

test("a worker a request started that outlives the workload's end fails the gate", async () => {
  const daemon = await standIn({ workers: 1, observed: true });
  const idle = await daemon.sample();
  await daemon.request({ op: "work", leak: true });
  await daemon.request({ op: "work", leak: false });
  const active = await daemon.sample();
  await daemon.request({ op: "finish" });
  const settled = await daemon.sample(3);
  expect(threadViolations({ idle, active, settled }, limits)).toEqual([
    "JS workers after the workload: 2 worker-idle workers still alive",
  ]);
});
