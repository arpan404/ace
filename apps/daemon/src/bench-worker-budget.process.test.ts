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
import { threadViolations } from "../bench/budgets.ts";
import { Telemetry } from "../bench/telemetry-schema.ts";
import { threadCensus } from "../bench/threads.ts";

/**
 * The perf gate's worker budget on Bun, from the same pieces the gate uses: the telemetry
 * preload, the OS thread census and the budget rules, around a stand-in daemon
 * (bench/fixtures/worker-daemon.ts) that keeps the workers it is told to start.
 */
const bench = join(import.meta.dirname, "../bench");
const limits = { idleWorkers: 1, idleOwnThreads: 4, activeOwnThreads: 5, runtimeThreads: 48 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function violations(options: { workers: number; observed: boolean }) {
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
  const { workers } = await readWorkerSnapshot({
    read: async (id) =>
      Telemetry.parse(JSON.parse(await readFile(join(telemetry, `${id}.json`), "utf8"))),
    now: () => performance.now(),
    pause: () => delay(10),
    timeoutMs: 4000,
  });
  const census = await threadCensus(pid);
  const sample = { census, workers, workerFloor: workers.length };
  return threadViolations(sample, sample, limits);
}

test("one long-lived worker fits the idle budget", async () => {
  expect(await violations({ workers: 1, observed: true })).toEqual([]);
});

test("one more long-lived worker than the idle budget fails the gate", async () => {
  expect(await violations({ workers: 2, observed: true })).toEqual([
    "idle JS workers: 2 exceeds 1",
  ]);
});

test("workers no telemetry is attached to fail the gate as not measured, never as zero", async () => {
  expect(await violations({ workers: 1, observed: false })).toEqual([
    "idle JS workers: not measured (1 running, telemetry saw 0)",
    "active JS workers: not measured (1 running, telemetry saw 0)",
  ]);
});
