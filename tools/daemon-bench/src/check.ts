import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Baseline, compare, median, metricsOf, type Verdict } from "./compare.ts";
import { BenchResult } from "./result.ts";

/**
 * `bun run bench:daemon`: runs the benchmark (bundling once), takes the median of each
 * metric and fails when one regressed beyond the baseline's tolerance.
 *   --runs=N             repeat the benchmark N times (default 1)
 *   --results=a.json,…   gate existing results instead of running
 *   --update-baseline    write the medians as this platform's baseline
 * Other flags pass through to run.ts.
 */
const repo = resolve(import.meta.dirname, "../../..");
const baselinePath = resolve(import.meta.dirname, "../baseline.json");
const outputDir = join(repo, ".ace-dev/daemon-bench");
const argv = process.argv.slice(2);
const option = (name: string) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const own = ["runs", "results", "update-baseline"];
const passThrough = argv.filter((arg) => !own.some((name) => arg.startsWith(`--${name}`)));
const run = promisify(execFile);

async function bundle(): Promise<string> {
  const output = join(outputDir, "bundle");
  process.stderr.write("daemon bench: bundling the daemon\n");
  await run(
    process.execPath,
    [join(repo, "apps/daemon/bench/compile.ts"), "--cli", `--output=${output}`],
    {
      cwd: repo,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return join(output, "ace.mjs");
}

async function measure(): Promise<BenchResult[]> {
  const given = option("results");
  if (given)
    return Promise.all(
      given
        .split(",")
        .map(async (path) => BenchResult.parse(JSON.parse(await readFile(path, "utf8")))),
    );
  await mkdir(outputDir, { recursive: true });
  const entry = passThrough.some((arg) => arg.startsWith("--entry="))
    ? []
    : [`--entry=${await bundle()}`];
  const runs = Number(option("runs") ?? 1);
  const results: BenchResult[] = [];
  for (let index = 0; index < runs; index++) {
    const output = join(outputDir, `run-${index + 1}.json`);
    process.stderr.write(`daemon bench: run ${index + 1} of ${runs}\n`);
    const child = execFile(
      process.execPath,
      [join(import.meta.dirname, "run.ts"), ...entry, ...passThrough, `--output=${output}`],
      { cwd: repo, maxBuffer: 16 * 1024 * 1024 },
    );
    child.stderr?.pipe(process.stderr);
    const code = await new Promise((done) => child.once("close", done));
    if (code !== 0) throw new Error(`Benchmark run ${index + 1} failed`);
    results.push(BenchResult.parse(JSON.parse(await readFile(output, "utf8"))));
  }
  return results;
}

const format = (metric: string, value: number | undefined) => {
  if (value === undefined) return "-";
  if (/heapUsed|rss|footprint/.test(metric)) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
};
function report(verdicts: Verdict[], platform: string) {
  const rows = verdicts.map((v) => [
    v.status === "regressed"
      ? "FAIL"
      : v.status === "improved"
        ? "better"
        : v.status === "unbaselined"
          ? "new"
          : "ok",
    v.metric,
    format(v.metric, v.actual),
    format(v.metric, v.baseline),
    format(v.metric, v.limit),
    v.from && v.from !== platform ? `(vs ${v.from})` : "",
  ]);
  const header = ["", "metric", "actual", "baseline", "limit", ""];
  const widths = header.map((_, i) =>
    Math.max(...[header, ...rows].map((row) => (row[i] ?? "").length)),
  );
  for (const row of [header, ...rows])
    process.stdout.write(
      `${row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd()}\n`,
    );
}

const results = await measure();
// Saved results carry their own platform, so CI artifacts can be gated or adopted anywhere.
const platforms = new Set(results.map((result) => result.platform));
const [platform] = platforms;
if (platforms.size !== 1 || !platform) throw new Error("Results must come from one platform");
const actual = median(results.map(metricsOf));
const baseline = Baseline.parse(JSON.parse(await readFile(baselinePath, "utf8")));
if (argv.includes("--update-baseline")) {
  const node = results[0]?.node ?? process.version;
  baseline.platforms[platform] = { node, runs: results.length, metrics: actual };
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`Updated the ${platform} baseline from ${results.length} run(s).\n`);
} else {
  const verdicts = compare(actual, baseline, platform);
  report(verdicts, platform);
  const regressed = verdicts.filter((v) => v.status === "regressed");
  if (regressed.length) {
    process.stdout.write(`\n${regressed.length} metric(s) regressed beyond tolerance.\n`);
    process.exitCode = 1;
  } else if (verdicts.some((v) => v.status === "improved"))
    process.stdout.write(
      "\nSome metrics improved beyond tolerance; consider updating the baseline.\n",
    );
}
