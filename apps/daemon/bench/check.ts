import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const run = promisify(execFile);
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
  await run(process.execPath, [join(import.meta.dirname, "compile.ts"), `--output=${directory}`], {
    cwd: root,
    timeout: 20000,
  });
  // Deterministic facts, real stdout/SQLite/WebSocket edges, bounded reconnect gaps.
  const acceptance = await run(
    process.execPath,
    ["--expose-gc", join(import.meta.dirname, "long-thread.ts")],
    { cwd: root, timeout: 180000, maxBuffer: 1024 * 1024 },
  );
  process.stdout.write(acceptance.stdout);
  const output = join(directory, "measurement.json");
  await run(
    process.execPath,
    [
      join(import.meta.dirname, "measure.ts"),
      `--entry=${join(directory, "ace.mjs")}`,
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
  const data = Measurement.parse(JSON.parse(await readFile(output, "utf8")));
  const violations: string[] = [];
  function maximum(name: string, actual: number, limit: number) {
    if (actual > limit) violations.push(`${name}: ${actual} exceeds ${limit}`);
  }
  maximum("idle RSS", data.idle10.memory.rss, limits.idleRss);
  maximum("startup ms", data.startupMs, limits.startupMs);
  maximum("idle OS threads", data.idle10.threads, limits.idleThreads);
  maximum("idle JS workers", data.idle10.workers.length, limits.idleWorkers);
  maximum("active OS threads", data.active.threads, limits.activeThreads);
  maximum("p99 ms", data.p99Ms, limits.p99Ms);
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
  maximum("shutdown ms", data.shutdownMs, limits.shutdownMs);
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
    violations.push(`events/s: ${data.eventsPerSecond} below ${limits.eventsPerSecond}`);
  process.stdout.write(JSON.stringify({ limits, measurement: data, violations }, null, 2) + "\n");
  if (violations.length) throw new Error(violations.join("\n"));
} finally {
  await rm(directory, { recursive: true, force: true });
}
