/**
 * Merge-time benchmark only. What N CLI probes (`git --version`, C at a time) cost the daemon's
 * main thread, by where they spawn: the probe worker with node:child_process (before), the probe
 * worker with Bun.spawn (today), and the main thread itself with either. Optional CPU burners
 * keep the machine busy, as a loaded laptop is.
 *
 *   bun packages/provider-kit/src/probe-spawns.bench.ts [probes=200] [concurrency=20] [burners=0]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";
import { z } from "zod";
import { startBunProbe } from "./bun-probe.ts";
import { requireBunSpawner } from "./bun-spawn.ts";
import { createProbeThread } from "./probe-thread.ts";
import { probeOutput, spawnRawSupervised } from "./process.ts";

const count = (value: string | undefined, fallback: number) =>
  z.coerce
    .number()
    .int()
    .nonnegative()
    .parse(value ?? fallback);
const probes = count(process.argv[2], 200);
const concurrency = count(process.argv[3], 20);
const burners = count(process.argv[4], 0);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
const bun = requireBunSpawner();
const before = createProbeThread(new URL("./testing/supervised-probe-worker.ts", import.meta.url));
const today = createProbeThread();

const quantile = (values: number[], q: number) =>
  values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;

/** One probe; resolves with how long its synchronous start held this thread. */
type Probe = () => Promise<number>;
const modes: Record<string, Probe> = {
  "worker, child_process": async () => {
    await probeOutput("git", ["--version"], { thread: before });
    return 0;
  },
  "worker, Bun.spawn": async () => {
    await probeOutput("git", ["--version"], { thread: today });
    return 0;
  },
  "main, child_process": async () => {
    let held = 0;
    await probeOutput("git", ["--version"], {
      spawn(options) {
        const began = performance.now();
        const proc = spawnRawSupervised(options);
        held = performance.now() - began;
        return proc;
      },
    });
    return held;
  },
  "main, Bun.spawn": async () => {
    const began = performance.now();
    const probe = startBunProbe(bun, {
      command: "git",
      args: ["--version"],
      env,
      maxBytes: 1_048_576,
    });
    const held = performance.now() - began;
    await probe.exit;
    return held;
  },
};

async function measure(label: string, probe: Probe) {
  for (let index = 0; index < 10; index++) await probe();
  const held: number[] = [];
  const lags: number[] = [];
  let last = performance.now();
  const beat = setInterval(() => {
    const now = performance.now();
    lags.push(now - last - 1);
    last = now;
  }, 1);
  const cpu = process.cpuUsage();
  const began = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < probes) held.push(await probe());
    }),
  );
  const wall = performance.now() - began;
  const used = process.cpuUsage(cpu);
  clearInterval(beat);
  const start = label.startsWith("main")
    ? `, start held thread avg ${(held.reduce((a, b) => a + b, 0) / held.length).toFixed(2)} p99 ${quantile(held, 0.99).toFixed(2)} max ${quantile(held, 1).toFixed(2)} ms`
    : "";
  console.log(
    `${label.padEnd(22)} wall ${wall.toFixed(0)} ms, process CPU ${((used.user + used.system) / 1000).toFixed(0)} ms, ` +
      `main timer lag p50 ${quantile(lags, 0.5).toFixed(1)} p99 ${quantile(lags, 0.99).toFixed(1)} max ${quantile(lags, 1).toFixed(1)} ms${start}`,
  );
}

const busy: ChildProcess[] = [];
for (let index = 0; index < burners; index++)
  busy.push(spawn("/bin/sh", ["-c", "while :; do :; done"], { stdio: "ignore" }));
try {
  console.log(
    `${probes} probes, ${concurrency} at a time, ${burners} CPU burners on ${availableParallelism()} cores; load ${loadavg()[0]?.toFixed(0)}`,
  );
  for (let round = 0; round < 3; round++)
    for (const [label, probe] of Object.entries(modes)) await measure(label, probe);
} finally {
  for (const child of busy) child.kill("SIGKILL");
}
process.exit(0);
