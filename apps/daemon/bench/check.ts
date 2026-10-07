import { checkIdleImports } from "./idle-imports.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  retryTiming,
  runTimed as runSubprocess,
  readFreshMeasurement,
  checkBudgets,
} from "@ace/perf-kit";

const run = promisify(execFile);
const runTimed = (args: string[], options: { cwd: string; timeout: number; maxBuffer?: number }) =>
  runSubprocess(run, process.execPath, args, options, (stdout) => {
    process.stdout.write(stdout);
  });
function phase<T>(name: string, measure: () => Promise<T>): Promise<T> {
  return retryTiming(measure, (error) => {
    process.stderr.write(`${name}: ${error.message}; repeating the unchanged workload once\n`);
    if (error.cause instanceof Error) process.stderr.write(`${error.cause.message}\n`);
  });
}
// Serial durable ingest includes fsync and socket delivery. CPU contention and
// filesystem scheduling are part of that wall clock, so qualify timing on an idle
// host, as the device gate does. Keep every performance budget unchanged.
// Load average counts runnable threads, so scale with cores: a 16-core host idling at 12 is
// not saturated. Never qualify timing above 90% of cores (and keep the old floor of 8).
const maximumTimingLoad = Math.max(8, Math.floor(cpus().length * 0.9));
const overloaded = () => (loadavg()[0] ?? Infinity) >= maximumTimingLoad;
const directory = await mkdtemp(join(tmpdir(), "ace-perf-gate-"));
const root = resolve(import.meta.dirname, "../../..");
const long = process.argv.includes("--long");
const bytes = z.number().nonnegative();
const memory = z.object({ rss: bytes, heapUsed: bytes });
const Sample = z.object({ memory, threads: z.number().int(), workers: z.array(z.unknown()) });
const Measurement = z.object({
  startupMs: bytes,
  idle10: Sample,
  active: Sample,
  eventsPerSecond: bytes,
  p99Ms: bytes,
  shutdownMs: bytes,
  retainedStart: memory,
  retainedEnd: memory,
  soak: z.array(z.object({ elapsedMs: bytes, rss: bytes })),
});
const MiB = 1024 * 1024;
// Headroom above the measured Node 24/26 values. The 150 MiB goal remains open.
const limits = {
  idleRss: 256 * MiB,
  startupMs: 5000,
  idleThreads: 18,
  idleWorkers: 1,
  activeThreads: 20,
  eventsPerSecond: 300,
  p99Ms: 50,
  retainedHeapGrowth: 8 * MiB,
  retainedRssGrowth: 64 * MiB,
  shutdownMs: 1500,
};
try {
  await checkIdleImports();
  if (overloaded()) {
    process.stdout.write(
      `daemon perf: deferred, host load >= ${maximumTimingLoad}; rerun on an idle host to qualify timing\n`,
    );
  } else {
    let builds = 0;
    const entry = await phase("compile", async () => {
      const destination = join(directory, `build-${++builds}`);
      await runTimed([join(import.meta.dirname, "compile.ts"), `--output=${destination}`], {
        cwd: root,
        timeout: 20000,
      });
      return join(destination, "ace.mjs");
    });
    // Deterministic facts, real stdout/SQLite/WebSocket edges, bounded reconnect gaps.
    const acceptance = await phase("long-thread acceptance", () =>
      runTimed(["--expose-gc", join(import.meta.dirname, "long-thread-reliability.ts")], {
        cwd: root,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
      }),
    );
    process.stdout.write(acceptance.stdout);
    await phase("daemon measurement", async () => {
      const output = join(directory, "measurement.json");
      const { raw, deadline: deadlineFailure } = await readFreshMeasurement(output, () =>
        runTimed(
          [
            join(import.meta.dirname, "measure.ts"),
            `--entry=${entry}`,
            "--idle-ms=7000",
            `--soak-ms=${long ? 300000 : 5000}`,
            `--warmup-cycles=${long ? 64 : 8}`,
            "--collect",
            "--collect-workers",
            "--progress",
            "--fresh-cycles",
            `--output=${output}`,
          ],
          { cwd: root, timeout: long ? 360000 : 35000, maxBuffer: 4 * 1024 * 1024 },
        ),
      );
      const data = Measurement.parse(JSON.parse(raw));
      const violations: string[] = [];
      const timing: string[] = [];
      function maximumTiming(name: string, actual: number, limit: number) {
        if (actual > limit) timing.push(`${name}: ${actual} exceeds ${limit}`);
      }
      function maximum(name: string, actual: number, limit: number) {
        if (actual > limit) violations.push(`${name}: ${actual} exceeds ${limit}`);
      }
      maximum("idle RSS", data.idle10.memory.rss, limits.idleRss);
      maximumTiming("startup ms", data.startupMs, limits.startupMs);
      maximum("idle OS threads", data.idle10.threads, limits.idleThreads);
      maximum("idle JS workers", data.idle10.workers.length, limits.idleWorkers);
      maximum("active OS threads", data.active.threads, limits.activeThreads);
      maximumTiming("p99 ms", data.p99Ms, limits.p99Ms);
      maximum(
        "retained heap growth",
        data.retainedEnd.heapUsed - data.retainedStart.heapUsed,
        limits.retainedHeapGrowth,
      );
      maximum(
        "retained RSS growth",
        data.retainedEnd.rss - data.retainedStart.rss,
        limits.retainedRssGrowth,
      );
      maximumTiming("shutdown ms", data.shutdownMs, limits.shutdownMs);
      if (long) {
        const end = data.soak.at(-1)?.elapsedMs ?? 0;
        const prior = data.soak.filter(
          (sample) => sample.elapsedMs >= end / 2 && sample.elapsedMs < end * 0.75,
        );
        const final = data.soak.filter((sample) => sample.elapsedMs >= end * 0.75);
        if (prior.length < 8 || final.length < 8) throw new Error("Not enough long-soak samples");
        const mean = (samples: typeof prior) =>
          samples.reduce((sum, sample) => sum + sample.rss, 0) / samples.length;
        maximum("late-soak RSS growth", mean(final) - mean(prior), 16 * MiB);
      }
      if (data.eventsPerSecond < limits.eventsPerSecond)
        timing.push(`events/s: ${data.eventsPerSecond} below ${limits.eventsPerSecond}`);
      process.stdout.write(
        JSON.stringify(
          { limits, measurement: data, violations: [...violations, ...timing] },
          null,
          2,
        ) + "\n",
      );
      // Resource violations still fail even if the host became busy during this run.
      if (overloaded()) {
        process.stdout.write(
          `daemon timing: deferred, host load reached ${maximumTimingLoad}; rerun on an idle host\n`,
        );
        checkBudgets(violations, [], deadlineFailure);
      } else checkBudgets(violations, timing, deadlineFailure);
    });
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
