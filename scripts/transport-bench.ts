// SPDX-License-Identifier: Apache-2.0
/**
 * T1b.5's paired bench (the porting guide's "Measurements to schedule" items 5 and 6, direct path,
 * and item 1's daemon bench): `apps/daemon/bench/head-of-line.ts` and
 * `apps/daemon/bench/slow-link.ts`, plus `tools/daemon-bench/src/run.ts` with `ACE_LISTEN=lan`, run
 * on one build with the native remote listener off and on, A B A B, the configured number of pairs.
 *
 * Every leg runs the bench as a child in this checkout, with the on leg's `ACE_TRANSPORT` (default
 * `native,remote`) and a fresh `ACE_TRANSPORT_EVIDENCE` file. The benches' isolated daemons inherit
 * both (`tools/perf-kit/src/isolated-daemon.ts`, `tools/daemon-bench/src/daemon.ts`), so the leg's
 * evidence says what the Rust remote listener handled. A pair is void when its two legs' recorded
 * load differs by more than 2×, or when the on leg's evidence has no remote close line with handled
 * exchanges: the switch never carried the bench's traffic, so the pair proves nothing.
 *
 *   node scripts/transport-bench.ts [--switch=native,remote] [--pairs=3] [--out=DIR]
 *     [--benches=head-of-line,slow-link,daemon]
 *
 * Gates (`t1b-brief.md`; the daemon bench's are T1a's rows): every latency median and the
 * event-loop gap p99 at most off × 1.10; bytes within ±3% of off; the daemon bench's
 * `transactionsPerTurn` within ±1%, `idle.cpuPercent` at most off + 0.2 points, `heapUsed` at most
 * off + 4 MiB and `rss` at most off + 16 MiB. Report first: the numbers are printed whether they
 * pass or not. The exit status is non-zero when any pair is void, any valid pair fails a gate, or
 * any pair has no metric rows: a run that measured nothing proves nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunBinary, realNode } from "./runtimes.ts";
import { readEvidence } from "./transport-evidence.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

type Bench = "head-of-line" | "slow-link" | "daemon";
type Side = "off" | "on";
type Unit = "ms" | "bytes" | "points";

/** How a metric's on leg must compare with its off leg. */
type Gate =
  /** on ≤ off × limit. */
  | { kind: "ratio"; limit: number }
  /** |on − off| / off ≤ fraction. */
  | { kind: "within"; fraction: number }
  /** on ≤ off + limit, in the metric's own unit (bytes, or points of a core). */
  | { kind: "absolute"; limit: number };

/** One metric name's unit and gate. */
interface Metric {
  unit: Unit;
  gate: Gate;
}

/** One metric's samples in a leg. */
interface Samples {
  ms?: number[];
  bytes?: number[];
  points?: number[];
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

/** One metric's two legs in a pair. */
interface Compared {
  metric: string;
  metricSpec: Metric;
  off: number;
  on: number;
}

/** The argument form the benches take: `--name=value`. */
function argument(name: string, fallback: string): string {
  const flag = `--${name}=`;
  return process.argv.find((value) => value.startsWith(flag))?.slice(flag.length) ?? fallback;
}

const transported = argument("switch", "native,remote");
const pairs = Math.max(1, Number(argument("pairs", "3")));
const benches = argument("benches", "head-of-line,slow-link,daemon")
  .split(",")
  .filter(
    (value): value is Bench =>
      value === "head-of-line" || value === "slow-link" || value === "daemon",
  );
const out = argument("out", join(tmpdir(), `ace-transport-bench-${process.pid}`));

const MIB = 1024 * 1024;

/** The unit and gate of one metric: the brief's rows, and T1a's for the daemon bench. */
function metricFor(bench: Bench, metric: string): Metric {
  const kind = metric.slice(metric.lastIndexOf("|") + 1);
  if (bench === "daemon") {
    if (kind === "cpuMsPerTurn") return { unit: "ms", gate: { kind: "ratio", limit: 1.1 } };
    if (kind === "transactionsPerTurn")
      return { unit: "points", gate: { kind: "within", fraction: 0.01 } };
    if (kind === "cpuPercent") return { unit: "points", gate: { kind: "absolute", limit: 0.2 } };
    if (kind === "heapUsed") return { unit: "bytes", gate: { kind: "absolute", limit: 4 * MIB } };
    if (kind === "rss") return { unit: "bytes", gate: { kind: "absolute", limit: 16 * MIB } };
    return { unit: "points", gate: { kind: "within", fraction: 0.01 } };
  }
  return metric.endsWith("Bytes")
    ? { unit: "bytes", gate: { kind: "within", fraction: 0.03 } }
    : { unit: "ms", gate: { kind: "ratio", limit: 1.1 } };
}

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
function add(samples: Map<string, Samples>, key: string, value: number, unit: Unit): void {
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
      // The probe's own p99 over the episode's gaps (apps/daemon/bench/head-of-line-probe.ts).
      const gaps = number(field(field(episode, "probe"), "gapP99Ms"));
      if (gaps !== undefined) add(metrics, `${profile}|${kind}|eventLoopGapP99`, gaps, "ms");
    }
  }
  return { metrics, load: worstLoad(runs.map((run) => field(run, "load"))) };
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

/** The daemon bench's rows T1a gates: per-phase turns, idle CPU, heap and RSS, startup included. */
function daemonMetrics(decoded: unknown): { metrics: Map<string, Samples>; load: number } {
  const metrics = new Map<string, Samples>();
  const phases = ["newThreads", "sameThread", "longText"];
  for (const name of phases) {
    const phase = path(decoded, `phases.${name}`);
    for (const key of ["cpuMsPerTurn", "transactionsPerTurn"] as const) {
      const value = number(field(phase, key));
      if (value !== undefined) add(metrics, `${name}|${key}`, value, "points");
    }
    for (const key of ["heapUsed", "rss"] as const) {
      const value = number(field(field(phase, "memory"), key));
      if (value !== undefined) add(metrics, `${name}|${key}`, value, "bytes");
    }
  }
  const idle = field(decoded, "idle");
  const idleCpu = number(field(idle, "cpuPercent"));
  if (idleCpu !== undefined) add(metrics, "idle|cpuPercent", idleCpu, "points");
  for (const [where, memory] of [
    ["idle", field(idle, "memory")],
    ["startup", field(decoded, "startup")],
  ] as const)
    for (const key of ["heapUsed", "rss"] as const) {
      const value = number(field(memory, key));
      if (value !== undefined) add(metrics, `${where}|${key}`, value, "bytes");
    }
  // The daemon bench records the machine's load in the result's machine block under `load`.
  const machine = field(decoded, "machine");
  return { metrics, load: worstLoad([field(machine, "load"), field(decoded, "loadBefore")]) };
}

/** How one leg of one bench runs. */
function command(bench: Bench, file: string): { command: string; args: string[]; cwd: string } {
  if (bench === "head-of-line")
    return {
      command: bunBinary(),
      cwd: root,
      args: [
        join(root, "apps/daemon/bench/head-of-line.ts"),
        "--paths=direct",
        "--profiles=3g-slow,3g-fast",
        "--runs=3",
        `--output=${file}`,
      ],
    };
  if (bench === "slow-link")
    return {
      command: bunBinary(),
      cwd: join(root, "apps/daemon"),
      args: [
        "bench/slow-link.ts",
        "--paths=direct",
        "--profiles=3g-slow,3g-fast",
        `--output=${file}`,
      ],
    };
  const node = realNode();
  if (node === undefined) throw new Error("the daemon bench runs on Node, and no node is on PATH");
  return {
    command: node,
    cwd: root,
    // The daemon bench's daemon binds the LAN listener T1b.5's rows are about.
    args: [join(root, "tools/daemon-bench/src/run.ts"), `--output=${file}`],
  };
}

/** Runs one leg; a non-zero exit is the leg's failure, with its stderr already printed. */
function runLeg(bench: Bench, side: Side, index: number): Leg {
  const file = join(out, `${bench}-pair-${index}-${side}.json`);
  const evidence =
    side === "on" ? join(out, `${bench}-pair-${index}-on-evidence.jsonl`) : undefined;
  if (evidence !== undefined) rmSync(evidence, { force: true });
  const { command: executable, args, cwd } = command(bench, file);
  const env: NodeJS.ProcessEnv = { ...process.env, ACE_LISTEN: "lan" };
  delete env.ACE_TRANSPORT_EVIDENCE;
  if (side === "on") {
    env.ACE_TRANSPORT = transported;
    if (evidence !== undefined) env.ACE_TRANSPORT_EVIDENCE = evidence;
  } else {
    delete env.ACE_TRANSPORT;
  }
  process.stderr.write(`transport-bench: ${bench} pair ${index} ${side}\n`);
  const loadBefore = loadavg()[0] ?? 0;
  const run = spawnSync(executable, args, {
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
    bench === "head-of-line"
      ? headOfLineMetrics(decoded)
      : bench === "slow-link"
        ? slowLinkMetrics(decoded)
        : daemonMetrics(decoded);
  // The harness's own load reading covers a bench that records none (the daemon bench).
  const harnessLoad = Math.max(loadBefore, loadavg()[0] ?? 0);
  return {
    side,
    bench,
    file,
    load: Math.max(load, harnessLoad),
    metrics,
    ...(evidence === undefined ? {} : { evidence }),
  };
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

/** Every metric both legs report, with each side's median and its gate. */
function comparisons(pair: Pair): Compared[] {
  const values: Compared[] = [];
  for (const [metric, off] of pair.off.metrics) {
    const on = pair.on.metrics.get(metric);
    if (on === undefined) continue;
    const metricSpec = metricFor(pair.off.bench, metric);
    const offMedian = median(off[metricSpec.unit] ?? []);
    const onMedian = median(on[metricSpec.unit] ?? []);
    if (offMedian === undefined || onMedian === undefined) continue;
    values.push({ metric, metricSpec, off: offMedian, on: onMedian });
  }
  return values;
}

/** Whether a comparison passes its gate. */
function passes(gate: Gate, off: number, on: number): boolean {
  if (gate.kind === "ratio") return on <= off * gate.limit;
  if (gate.kind === "absolute") return on <= off + gate.limit;
  return off === 0 ? on === 0 : Math.abs(on - off) / off <= gate.fraction;
}

/** The gate in words, for the report. */
function gateText(gate: Gate): string {
  if (gate.kind === "ratio") return `on ≤ off × ${gate.limit.toFixed(2)}`;
  if (gate.kind === "absolute")
    return gate.limit >= MIB
      ? `on ≤ off + ${String(Math.round(gate.limit / MIB))} MiB`
      : `on ≤ off + ${gate.limit}`;
  return `on within ±${(gate.fraction * 100).toFixed(0)}% of off`;
}

/** Prints the per-pair numbers and returns whether every pair, and every metric, passed. */
function report(all: readonly Pair[], bench: Bench): boolean {
  const valid = all.filter((pair) => pair.void === undefined);
  console.log(`\n=== ${bench} (direct path) ===`);
  let passed = true;
  for (const pair of all) {
    if (pair.void === undefined) continue;
    passed = false;
    console.log(`pair ${pair.index}: VOID — ${pair.void}`);
  }
  if (valid.length !== all.length) {
    console.log(
      `  ${String(valid.length)} of ${String(all.length)} pairs valid: the run needs all of them`,
    );
    return false;
  }
  const perPair = valid.map((pair) => comparisons(pair));
  if (perPair.some((rows) => rows.length === 0)) {
    console.log("  a pair has no metric rows: the report held nothing to compare");
    return false;
  }
  const metrics = [...new Set(perPair.flatMap((rows) => rows.map((row) => row.metric)))].toSorted();
  for (const metric of metrics) {
    const rows = perPair.map((list) => list.find((row) => row.metric === metric));
    const spec = rows.find((row) => row !== undefined)?.metricSpec;
    if (spec === undefined) continue;
    const ok = rows.every((row) => row !== undefined && passes(spec.gate, row.off, row.on));
    if (!ok) passed = false;
    const detail = rows
      .map((row) => (row === undefined ? "—" : `${row.off.toFixed(2)}→${row.on.toFixed(2)}`))
      .join(" ");
    console.log(
      `  ${ok ? "pass" : "FAIL"} ${metric.padEnd(44)} ${spec.unit.padEnd(6)} ${detail}  [${gateText(spec.gate)}]`,
    );
  }
  console.log(`  ${String(valid.length)} pair(s), every metric row gated as shown`);
  return passed;
}

function main(): number {
  if (process.argv.includes("--help")) {
    console.log(
      [
        "scripts/transport-bench.ts — the paired bench: native remote listener off, then on, A B A B",
        "",
        "  node scripts/transport-bench.ts [--switch=native,remote] [--pairs=3] [--out=DIR]",
        "    [--benches=head-of-line,slow-link,daemon]",
        "",
        "Requires ACE_TRANSPORT_ADDON to name this checkout's transport addon; every leg's",
        "isolated daemon inherits the switch and the on leg's ACE_TRANSPORT_EVIDENCE file.",
        "Every configured pair must be valid, and every pair must report metrics, or the run fails.",
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
