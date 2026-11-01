// Prints the slowest test files and per-project totals from a recorded run.
//
//   node scripts/test-timings.ts [test-timings/full.json] [--top 30]
//
// Durations are wall time inside a worker, so they include waiting for CPU when other workers
// (or other work on the machine) compete. Compare runs made with the same worker count.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const topIndex = argv.indexOf("--top");
const top = topIndex >= 0 ? Number(argv[topIndex + 1]) : 30;
const path =
  argv.find((arg, index) => !arg.startsWith("--") && index !== topIndex + 1) ??
  join(root, "test-timings/full.json");

const summary = z
  .object({
    finishedAt: z.string(),
    workers: z.number(),
    cpus: z.number(),
    files: z.array(
      z.object({ file: z.string(), project: z.string(), ownMs: z.number(), collectMs: z.number() }),
    ),
  })
  .parse(JSON.parse(readFileSync(path, "utf8")));

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`.padStart(8);
console.log(
  `${path}: ${summary.files.length} files, finished ${summary.finishedAt}, ` +
    `${summary.workers} workers on ${summary.cpus} CPUs`,
);
const totals = new Map<string, { files: number; ms: number }>();
for (const file of summary.files) {
  const total = totals.get(file.project) ?? { files: 0, ms: 0 };
  totals.set(file.project, { files: total.files + 1, ms: total.ms + file.ownMs });
}
console.log("\nProject totals (sum of test and hook time):");
for (const [project, total] of [...totals].toSorted((a, b) => b[1].ms - a[1].ms))
  console.log(`${seconds(total.ms)}  ${String(total.files).padStart(5)} files  ${project}`);
console.log(`\nSlowest ${top} files (tests and hooks, then import time):`);
for (const file of summary.files.toSorted((a, b) => b.ownMs - a.ownMs).slice(0, top))
  console.log(
    `${seconds(file.ownMs)} ${seconds(file.collectMs)}  ${file.project.padEnd(15)} ${file.file}`,
  );
