// SPDX-License-Identifier: Apache-2.0
/**
 * T1b.5's paired bench (the porting guide's "Measurements to schedule" items 5 and 6, direct path):
 * `apps/daemon/bench/head-of-line.ts` and `apps/daemon/bench/slow-link.ts`, run on one build with
 * the native remote listener off and on, A B A B, three pairs. Item 1 of the guide's T1b.5 table
 * (`tools/daemon-bench`) is T1a's own run and is not this script's.
 *
 * Every leg runs the bench as a child in this checkout, with the on leg's `ACE_TRANSPORT` (default
 * `native,remote`) and a fresh `ACE_TRANSPORT_EVIDENCE` file. The bench's isolated daemons inherit
 * both (`tools/perf-kit/src/isolated-daemon.ts`), so the leg's evidence says what the Rust remote
 * listener handled. A pair is void when its two legs' recorded load differs by more than 2×, or
 * when the on leg's evidence has no remote close line with handled exchanges: then the switch
 * never carried the bench's traffic and the pair proves nothing.
 *
 *   node scripts/transport-bench.ts [--switch=native,remote] [--pairs=3] [--out=DIR]
 *     [--benches=head-of-line,slow-link]
 *
 * Gates (`t1b-brief.md`): every latency median and the event-loop gap p99 at most off × 1.10, and
 * the bytes within ±3% of off. Report first: the numbers are printed whether they pass or not, and
 * the exit status is non-zero when a valid pair fails a gate or when no pair is valid.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunBinary } from "./runtimes.ts";
import { readEvidence } from "./transport-evidence.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

type Bench = "head-of-line" | "slow-link";
type Side = "off" | "on";

/** One metric of one leg: its per-pair samples, in the bench's own units. */
interface Samples {
  ms?: number[];
  bytes?: number[];
}

/** A leg's report, its recorded load and its evidence file. */
interface Leg {
  side: Side;
  bench: Bench;
  file: string;
  /** The worst 1-minute load average the leg recorded. */
  load: number;
  /** The evidence file, on the on leg only. */
  evidence?: string;
  metrics: Map<string, Samples>;
}

/** How a pair ended up. */
interface Pair {
  index: number;
  off: Leg;
  on: Leg;
  void?: string;
}

/** The argument form the benches take: `--name=value`. */
function argument(name: string, fallback: string): string {
  const flag = `--${name}=`;
  return process.argv.find((value) => value.startsWith(flag))?.slice(flag.length) ?? fallback;
}

const transported = argument("switch", "native,remote");
const pairs = Math.max(1, Number(argument("pairs", "3")));
const benches = argument("benches", "head-of-line,slow-link")
  .split(",")
  .filter((value): value is Bench => value === "head-of-line" || value === "slow-link");
const out = argument("out", join(tmpdir(), `ace-transport-bench-${process.pid}`));

/** The median of a series; an empty series has none. */
function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return lower === undefined || upper === undefined ? undefined : (lower + upper) / 2;
}

/** A number field of a decoded object, or undefined. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

/** A finite number, or undefined. */
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Adds one sample under `key`. */
function add(
  samples: Map<string, Samples>,
  key: string,
  value: number,
  unit: "ms" | "bytes",
): void {
  const entry = samples.get(key) ?? {};
  (entry[unit] ??= []).push(value);
  samples.set(key, entry);
}

/** Walks `a.b.c` through a decoded object. */
function path(value: unknown, name: string): unknown {
  let current = value;
  for (const part of name.split(".")) current = field(current, part);
  return current;
}

/** The worst 1-minute load average among the arrays the bench recorded. */
function worstLoad(values: readonly unknown[]): number {
  let worst = 0;
  for (const value of values) {
    const first = Array.isArray(value) ? number(value[0]) : undefined;
    if (first !== undefined && first > worst) worst = first;
  }
  return worst;
}

/** One head-of-line report: every urgent kind's wait and the gaps, per profile and bulk kind. */
function headOfLineMetrics(decoded: unknown): { metrics: Map<string, Samples>; load: number } {
  const metrics = new Map<string, Samples>();
  const results = field(decoded, "results");
  const runs = Array.isArray(results) ? results : [];
  for (const run of runs) {
    const profile = String(field(run, "profile"));
    const result = field(run, "result");
    const episodes: [string, unknown][] = [["idle", field(result, "idle")]];
    const bulk = field(result, "episodes");
    if (typeof bulk === "object" && bulk !== null)
      for (const kind of Object.keys(bulk)) episodes.push([kind, Reflect.get(bulk, kind)]);
    for (const [kind, episode] of episodes) {
      const urgent = field(episode, "urgent");
      for (const name of ["stopAck", "sendReceipt"]) {
        const wait = field(urgent, name);
        const ms = number(field(wait, "ms"));
        if (ms !== undefined) add(metrics, `${profile}|${kind}|${name}`, ms, "ms");
        const ahead = number(field(wait, "aheadBytes"));
        if (ahead !== undefined)
          add(metrics, `${profile}|${kind}|${name}AheadBytes`, ahead, "bytes");
      }
      const bytes = number(field(field(episode, "bulk"), "bytes"));
      if (bytes !== undefined) add(metrics, `${profile}|${kind}|bulkBytes`, bytes, "bytes");
      // The probe keeps each episode's five longest event-loop gaps: the longest is the tail's tail.
      const gaps = field(field(episode, "probe"), "longestGaps");
      const longest = Array.isArray(gaps)
        ? Math.max(0, ...gaps.map((gap) => number(field(gap, "ms")) ?? 0))
        : undefined;
      if (longest !== undefined) add(metrics, `${profile}|${kind}|eventLoopGapP99`, longest, "ms");
    }
  }
  return {
    metrics,
    load: worstLoad(runs.map((run) => field(run, "load"))),
  };
}

/** The slow-link spans the brief's rows name, with the two approval delays. */
const SLOW_LINK_SPANS = [
  "welcome",
  "sidebar",
  "firstContent.small",
  "firstContent.typical",
  "firstContent.large",
  "complete.large",
  "cached.paint",
  "cached.confirmed",
  "reconnect.welcome",
  "reconnect.confirmed",
  "resume",
];

/** One slow-link report: each reported span's median latency and bytes, per profile. */
function slowLinkMetrics(decoded: unknown): { metrics: Map<string, Samples>; load: number } {
  const metrics = new Map<string, Samples>();
  const results = field(decoded, "runs");
  const runs = Array.isArray(results) ? results : [];
  for (const run of runs) {
    const profile = String(field(run, "profile"));
    for (const name of SLOW_LINK_SPANS) {
      const span = path(run, name);
      const ms = number(field(span, "ms"));
      if (ms !== undefined) add(metrics, `${profile}|${name}`, ms, "ms");
      const bytes = number(field(span, "downBytes"));
      if (bytes !== undefined) add(metrics, `${profile}|${name}Bytes`, bytes, "bytes");
    }
    for (const name of ["idleMs", "duringLargeSnapshotMs"]) {
      const ms = number(field(field(run, "approval"), name));
      if (ms !== undefined) add(metrics, `${profile}|approval.${name}`, ms, "ms");
    }
  }
  const machine = field(decoded, "machine");
  return {
    metrics,
    load: worstLoad([field(machine, "loadBefore"), field(machine, "loadAfter")]),
  };
}

/** The command one leg runs, and the directory it runs in. */
function command(bench: Bench, file: string): { args: string[]; cwd: string } {
  if (bench === "head-of-line")
    return {
      cwd: root,
      args: [
        join(root, "apps/daemon/bench/head-of-line.ts"),
        "--paths=direct",
        "--profiles=3g-slow,3g-fast",
        "--runs=3",
        `--output=${file}`,
      ],
    };
  return {
    cwd: join(root, "apps/daemon"),
    args: [
      "bench/slow-link.ts",
      "--paths=direct",
      "--profiles=3g-slow,3g-fast",
      `--output=${file}`,
    ],
  };
}

/** Runs one leg; a non-zero exit is the leg's failure, with its stderr already printed. */
function runLeg(bench: Bench, side: Side, index: number): Leg {
  const file = join(out, `${bench}-pair-${index}-${side}.json`);
  const evidence =
    side === "on" ? join(out, `${bench}-pair-${index}-on-evidence.jsonl`) : undefined;
  if (evidence !== undefined) rmSync(evidence, { force: true });
  const { args, cwd } = command(bench, file);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ACE_TRANSPORT_EVIDENCE;
  if (side === "on") {
    env.ACE_TRANSPORT = transported;
    if (evidence !== undefined) env.ACE_TRANSPORT_EVIDENCE = evidence;
  } else {
    delete env.ACE_TRANSPORT;
  }
  process.stderr.write(`transport-bench: ${bench} pair ${index} ${side}\n`);
  const run = spawnSync(bunBinary(), args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 4 * 60 * 60 * 1000,
  });
  if (run.status !== 0)
    throw new Error(`${bench} ${side} leg exited ${String(run.status)}; see its output above`);
  if (!existsSync(file)) throw new Error(`${bench} ${side} leg wrote no report at ${file}`);
  const decoded: unknown = JSON.parse(readFileSync(file, "utf8"));
  const { metrics, load } =
    bench === "head-of-line" ? headOfLineMetrics(decoded) : slowLinkMetrics(decoded);
  return { side, bench, file, load, metrics, ...(evidence === undefined ? {} : { evidence }) };
}

/** Why a pair proves nothing, or undefined when both legs are comparable. */
function voidReason(pair: Pair): string | undefined {
  const { off, on } = pair;
  const high = Math.max(off.load, on.load, 1);
  const low = Math.min(off.load, on.load);
  if (high / Math.max(low, 0.01) > 2)
    return `load ${off.load.toFixed(2)} vs ${on.load.toFixed(2)} differs by more than 2×`;
  if (on.evidence === undefined) return "the on leg has no evidence file";
  const served = readEvidence(on.evidence).some(
    (line) =>
      line.event === "close" &&
      line.listener === "remote" &&
      (line.exchanges ?? 0) + (line.upgrades ?? 0) > 0,
  );
  if (!served) return "the on leg's evidence has no remote close line with handled exchanges";
  return undefined;
}

/** One metric's ratio over a pair. */
interface Ratio {
  metric: string;
  unit: "ms" | "bytes";
  value: number;
}

/** Every metric both legs report, as on/off ratios. */
function ratios(pair: Pair): Ratio[] {
  const values: Ratio[] = [];
  for (const [metric, off] of pair.off.metrics) {
    const on = pair.on.metrics.get(metric);
    if (on === undefined) continue;
    for (const unit of ["ms", "bytes"] as const) {
      const offMedian = median(off[unit] ?? []);
      const onMedian = median(on[unit] ?? []);
      if (offMedian === undefined || onMedian === undefined || offMedian === 0) continue;
      values.push({ metric, unit, value: onMedian / offMedian });
    }
  }
  return values;
}

/** The gate for one unit: latency may grow 10%, bytes must stay within 3%. */
function withinGate(unit: "ms" | "bytes", ratio: number): boolean {
  return unit === "ms" ? ratio <= 1.1 : Math.abs(ratio - 1) <= 0.03;
}

/** Prints the per-pair and combined ratios, and returns whether every valid pair passed. */
function report(all: readonly Pair[], bench: Bench): boolean {
  const valid = all.filter((pair) => pair.void === undefined);
  console.log(`\n=== ${bench} (direct path) ===`);
  for (const pair of all)
    console.log(
      `pair ${pair.index}: ${pair.void === undefined ? "counted" : `VOID — ${pair.void}`}`,
    );
  if (!valid.length) {
    console.log("  no valid pair: the run proves nothing");
    return false;
  }
  const perPair = valid.map((pair) => ratios(pair));
  const metrics = [
    ...new Set(perPair.flatMap((list) => list.map((one) => `${one.unit} ${one.metric}`))),
  ];
  let passed = true;
  for (const key of metrics.toSorted()) {
    const [unit, ...rest] = key.split(" ");
    const metric = rest.join(" ");
    const unitKind = unit === "ms" ? "ms" : "bytes";
    const values = perPair.map(
      (list) => list.find((one) => one.metric === metric && one.unit === unitKind)?.value,
    );
    const medians = values.filter((value): value is number => value !== undefined);
    const combined = median(medians);
    if (combined === undefined) continue;
    const ok = withinGate(unitKind, combined);
    if (!ok) passed = false;
    const detail = values.map((value) => (value === undefined ? "—" : value.toFixed(3))).join(" ");
    console.log(
      `  ${ok ? "pass" : "FAIL"} ${metric.padEnd(46)} ${unitKind.padEnd(5)} ${combined.toFixed(3)}  [${detail}]`,
    );
  }
  console.log(`  medians of ${valid.length} valid pair(s); gate: ms ≤ 1.10, bytes within ±3%`);
  return passed;
}

function main(): number {
  if (process.argv.includes("--help")) {
    console.log(
      [
        "scripts/transport-bench.ts — the paired bench: native remote listener off, then on, A B A B",
        "",
        "  node scripts/transport-bench.ts [--switch=native,remote] [--pairs=3] [--out=DIR]",
        "    [--benches=head-of-line,slow-link]",
        "",
        "Requires ACE_TRANSPORT_ADDON to name this checkout's transport addon; every leg's",
        "isolated daemon inherits the switch and the on leg's ACE_TRANSPORT_EVIDENCE file.",
      ].join("\n"),
    );
    return 0;
  }
  if (process.env.ACE_TRANSPORT_ADDON === undefined || process.env.ACE_TRANSPORT_ADDON === "")
    throw new Error(
      "set ACE_TRANSPORT_ADDON to this checkout's transport addon: the paired bench's on leg needs it",
    );
  mkdirSync(out, { recursive: true });
  console.log(`switch ${transported}, ${pairs} pair(s), output ${out}`);
  let passed = true;
  for (const bench of benches) {
    const all: Pair[] = [];
    for (let index = 1; index <= pairs; index++) {
      const off = runLeg(bench, "off", index);
      const on = runLeg(bench, "on", index);
      const pair: Pair = { index, off, on };
      pair.void = voidReason(pair);
      all.push(pair);
    }
    if (!report(all, bench)) passed = false;
  }
  return passed ? 0 : 1;
}

process.exitCode = main();
