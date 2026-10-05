import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { retryTiming, TimingFailure } from "@ace/perf-kit";

const run = promisify(execFile);
const TimedOut = z.object({
  killed: z.literal(true),
  // maxBuffer failures also kill with SIGTERM, but carry a string error code.
  code: z.number().int().nullable(),
  // measure.ts handles SIGTERM and exits itself: killed stays true, signal is null.
  signal: z.literal("SIGTERM").nullable(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
const AcceptanceFailed = z.object({ type: z.literal("acceptance.failed") });
async function runTimed(
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer?: number },
) {
  try {
    return await run(process.execPath, args, options);
  } catch (error) {
    const timeout = TimedOut.safeParse(error);
    if (!timeout.success) throw error;
    if (timeout.data.stdout) process.stdout.write(timeout.data.stdout);
    // A failed assertion can be followed by slow cleanup. Its deadline must not
    // turn that correctness failure into a retryable timing sample.
    const failed = (timeout.data.stderr ?? "").split("\n").some((line) => {
      try {
        return AcceptanceFailed.safeParse(JSON.parse(line)).success;
      } catch {
        return false;
      }
    });
    if (failed) throw error;
    throw new TimingFailure(`subprocess exceeded its ${options.timeout} ms deadline`, {
      cause: error,
    });
  }
}
function phase<T>(name: string, measure: () => Promise<T>): Promise<T> {
  return retryTiming(measure, (error) => {
    process.stderr.write(`${name}: ${error.message}; repeating the unchanged workload once\n`);
    if (error.cause instanceof Error) process.stderr.write(`${error.cause.message}\n`);
  });
}
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
    await rm(output, { force: true });
    let deadlineFailure: TimingFailure | undefined;
    try {
      await runTimed(
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
      );
    } catch (error) {
      if (!(error instanceof TimingFailure)) throw error;
      deadlineFailure = error;
    }
    // A completed sample followed by slow cleanup still has resource results.
    // Validate those before deciding whether its deadline qualifies for a repeat.
    const raw = await readFile(output, "utf8").catch((error: unknown) => {
      if (deadlineFailure && z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
        throw deadlineFailure;
      throw error;
    });
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
    if (violations.length) throw new Error(violations.join("\n"));
    if (deadlineFailure) throw deadlineFailure;
    if (timing.length) throw new TimingFailure(timing.join("\n"));
  });
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
