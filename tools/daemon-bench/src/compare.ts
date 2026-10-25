import { z } from "zod";
import type { BenchResult } from "./result.ts";

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
  version: z.literal(1),
  tolerances: z.array(Tolerance).min(1),
  /** Measured values per `platform-arch`, keyed by metric path. */
  platforms: z.record(
    z.string(),
    z.object({
      node: z.string(),
      runs: z.number().int().positive(),
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

function matches(pattern: string, metric: string) {
  const parts = pattern.split(".");
  const names = metric.split(".");
  return (
    parts.length === names.length && parts.every((part, i) => part === "*" || part === names[i])
  );
}

/** Compares measured metrics with the baseline; only growth beyond tolerance regresses. */
export function compare(
  actual: Record<string, number>,
  baseline: Baseline,
  platform: string,
): Verdict[] {
  const own = baseline.platforms[platform];
  const others = Object.entries(baseline.platforms).filter(([name]) => name !== platform);
  const verdicts: Verdict[] = [];
  for (const [metric, value] of Object.entries(actual)) {
    const tolerance = baseline.tolerances.find((entry) => matches(entry.metric, metric));
    if (!tolerance) continue;
    let from: string | undefined;
    let reference: number | undefined;
    if (own?.metrics[metric] !== undefined) {
      from = platform;
      reference = own.metrics[metric];
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
