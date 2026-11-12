/**
 * Runs allocation-rate.ts against several bundles, interleaved (A B A B …) so host load hits
 * each alike, and prints the median of each configuration's per-run medians.
 *
 *   bun apps/daemon/bench/allocation-compare.ts --runs=3 --events=5000 \
 *     .ace-dev/alloc-base/ace.mjs .ace-dev/alloc-fix/ace.mjs
 *
 * Other `--name=value` arguments (--subscribers, --windows) pass through to every run.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";

const run = promisify(execFile);
const options = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const entries = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const runs = z.coerce
  .number()
  .int()
  .min(1)
  .parse(options.find((arg) => arg.startsWith("--runs="))?.slice(7) ?? "3");
const passed = options.filter((arg) => !arg.startsWith("--runs="));
const Result = z.object({
  allocatedPer1000: z.number(),
  workerAllocatedPer1000: z.number(),
  collectionsPer1000: z.number(),
  transactionsPer1000: z.number(),
  cpuMsPer1000: z.number(),
  peakHeapUsed: z.number(),
  eventsPerSecond: z.number(),
});
const results = new Map<string, z.infer<typeof Result>[]>(entries.map((entry) => [entry, []]));
for (let index = 0; index < runs; index++)
  for (const entry of entries) {
    const { stdout } = await run(
      process.execPath,
      [join(import.meta.dirname, "allocation-rate.ts"), `--entry=${entry}`, ...passed],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const result = Result.parse(JSON.parse(stdout));
    results.get(entry)?.push(result);
    process.stderr.write(`${entry} run ${index + 1}: ${JSON.stringify(result)}\n`);
  }
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
const rows = [...results].map(([entry, list]) => ({
  entry,
  runs: list.length,
  allocatedKBPer1000: Math.round(median(list.map((r) => r.allocatedPer1000)) / 1024),
  workerAllocatedKBPer1000: Math.round(median(list.map((r) => r.workerAllocatedPer1000)) / 1024),
  collectionsPer1000: median(list.map((r) => r.collectionsPer1000)),
  transactionsPer1000: median(list.map((r) => r.transactionsPer1000)),
  cpuMsPer1000: Math.round(median(list.map((r) => r.cpuMsPer1000))),
  peakHeapUsedMB: Math.round(median(list.map((r) => r.peakHeapUsed)) / 1e5) / 10,
  eventsPerSecond: Math.round(median(list.map((r) => r.eventsPerSecond))),
}));
process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
