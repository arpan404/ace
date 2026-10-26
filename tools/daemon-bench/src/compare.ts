import { z } from "zod";
import type { BenchResult } from "./result.ts";
import { requireSameWorkload, Workload, workloadDifferences } from "./workload.ts";

/**
 * A metric may grow by `relative` (0.25 = 25%) over its baseline, and always by at least
 * `absolute` in its own unit, so tiny values don't fail on noise. Portable metrics are
 * normalized or deterministic and compare against another platform's baseline when this
 * platform has none.
 */
export const Tolerance = z.object({
  metric: z.string().min(1),
  relative: z.number().nonnegative(),
  absolute: z.number().nonnegative().default(0),
  portable: z.boolean().default(false),
});
export type Tolerance = z.infer<typeof Tolerance>;
export const Baseline = z.object({
  version: z.literal(2),
  tolerances: z.array(Tolerance).min(1),
  /** Measured values per `platform-arch`, keyed by metric path. */
  platforms: z.record(
    z.string(),
    z.object({
      node: z.string(),
      runs: z.number().int().positive(),
      /** The workload these numbers measured; only runs of the same one compare. */
      workload: Workload,
      metrics: z.record(z.string(), z.number()),
    }),
  ),
});
export type Baseline = z.infer<typeof Baseline>;

export interface Verdict {
  metric: string;
  actual: number;
  baseline: number | undefined;
  limit: number | undefined;
  /** Platform whose baseline was used. */
  from: string | undefined;
  status: "pass" | "regressed" | "improved" | "unbaselined";
}

/** Every gated value of a run, keyed by its dotted path. */
export function metricsOf(result: BenchResult): Record<string, number> {
  const out: Record<string, number> = {
    "idle.cpuPerMinute": result.idle.cpuPerMinute,
    "startup.heapUsed": result.startup.heapUsed,
    "startup.rss": result.startup.rss,
  };
  if (result.startup.footprint !== undefined) out["startup.footprint"] = result.startup.footprint;
  for (const [name, phase] of Object.entries(result.phases)) {
    out[`phases.${name}.cpuPerTurn`] = phase.cpuPerTurn;
    out[`phases.${name}.transactionsPerTurn`] = phase.transactionsPerTurn;
    out[`phases.${name}.heapUsed`] = phase.memory.heapUsed;
    out[`phases.${name}.rss`] = phase.memory.rss;
    if (phase.memory.footprint !== undefined)
      out[`phases.${name}.footprint`] = phase.memory.footprint;
  }
  return out;
}

/** The middle value per metric across repeated runs; one slow run can't fail the gate. */
export function median(runs: readonly Record<string, number>[]): Record<string, number> {
  const names = new Set(runs.flatMap((run) => Object.keys(run)));
  const out: Record<string, number> = {};
  for (const name of names) {
    const values = runs
      .map((run) => run[name])
      .filter((value): value is number => value !== undefined)
      .toSorted((a, b) => a - b);
    const middle = values.length >> 1;
    out[name] =
      values.length % 2
        ? (values[middle] ?? 0)
        : ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
  }
  return out;
}

/** Repeated runs of one workload on one platform, reduced to medians. */
export interface Measured {
  platform: string;
  node: string;
  runs: number;
  workload: Workload;
  metrics: Record<string, number>;
}
/** Medians across runs; refuses to mix platforms, Node versions or workloads. */
export function combine(results: readonly BenchResult[]): Measured {
  const [first, ...rest] = results;
  if (!first) throw new Error("No benchmark results to combine");
  for (const [index, result] of rest.entries()) {
    if (result.platform !== first.platform)
      throw new Error(
        `Results must come from one platform: run 1 is ${first.platform}, run ${index + 2} is ${result.platform}`,
      );
    if (result.node !== first.node)
      throw new Error(
        `Results must come from one Node version: run 1 is ${first.node}, run ${index + 2} is ${result.node}`,
      );
    requireSameWorkload(
      `Run ${index + 2} measured a different workload from run 1`,
      first.workload,
      result.workload,
    );
  }
  return {
    platform: first.platform,
    node: first.node,
    runs: results.length,
    workload: first.workload,
    metrics: median(results.map(metricsOf)),
  };
}

/**
 * The baseline with `measured` as its platform's entry. Only the standard workload may become
 * a baseline: a shortened or altered run would make every later standard run fail or pass
 * against the wrong numbers.
 */
export function adopt(baseline: Baseline, measured: Measured, standard: Workload): Baseline {
  requireSameWorkload(
    "Refusing to adopt results that did not run the standard workload",
    standard,
    measured.workload,
  );
  const { platform, node, runs, workload, metrics } = measured;
  return {
    ...baseline,
    platforms: { ...baseline.platforms, [platform]: { node, runs, workload, metrics } },
  };
}

/** Platforms whose baseline measured another workload and need re-measuring. */
export function staleBaselines(baseline: Baseline, standard: Workload): string[] {
  return Object.entries(baseline.platforms)
    .filter(([, entry]) => workloadDifferences(standard, entry.workload).length > 0)
    .map(([name]) => name);
}

const nodeMajor = (version: string) => /^v?(\d+)/.exec(version)?.[1];

function matches(pattern: string, metric: string) {
  const parts = pattern.split(".");
  const names = metric.split(".");
  return (
    parts.length === names.length && parts.every((part, i) => part === "*" || part === names[i])
  );
}

/**
 * Compares measured metrics with the baseline; only growth beyond tolerance regresses. Throws
 * when the baseline used measured a different workload, rather than comparing unlike runs.
 */
export function compare(measured: Measured, baseline: Baseline): Verdict[] {
  const { platform, metrics: actual } = measured;
  const own = baseline.platforms[platform];
  // Memory and idle costs depend on the runtime: another Node major's numbers don't hold.
  const sameRuntime = own !== undefined && nodeMajor(own.node) === nodeMajor(measured.node);
  const others = Object.entries(baseline.platforms).filter(([name]) => name !== platform);
  if (own)
    requireSameWorkload(
      `The ${platform} baseline measured a different workload`,
      own.workload,
      measured.workload,
    );
  const portableTolerance = baseline.tolerances.some((tolerance) => tolerance.portable);
  if (!own && portableTolerance)
    for (const [name, entry] of others)
      requireSameWorkload(
        `The ${name} baseline (compared because ${platform} has none) measured a different workload`,
        entry.workload,
        measured.workload,
      );
  const verdicts: Verdict[] = [];
  for (const [metric, value] of Object.entries(actual)) {
    const tolerance = baseline.tolerances.find((entry) => matches(entry.metric, metric));
    if (!tolerance) continue;
    let from: string | undefined;
    let reference: number | undefined;
    if (own?.metrics[metric] !== undefined && (sameRuntime || tolerance.portable)) {
      from = platform;
      reference = own.metrics[metric];
    } else if (own?.metrics[metric] !== undefined) {
      from = platform;
    } else if (!own && tolerance.portable) {
      const other = others.find(([, entry]) => entry.metrics[metric] !== undefined);
      from = other?.[0];
      reference = other?.[1].metrics[metric];
    }
    if (reference === undefined) {
      verdicts.push({
        metric,
        actual: value,
        baseline: undefined,
        limit: undefined,
        from,
        status: "unbaselined",
      });
      continue;
    }
    const margin = Math.max(reference * tolerance.relative, tolerance.absolute);
    const limit = reference + margin;
    const status = value > limit ? "regressed" : value < reference - margin ? "improved" : "pass";
    verdicts.push({ metric, actual: value, baseline: reference, limit, from, status });
  }
  return verdicts;
}
