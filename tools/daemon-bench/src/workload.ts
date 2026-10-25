import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Bump when what a run does changes without any option changing: a new phase, different
 * fake-CLI framing or filler, a different seeded thread. Old results and baselines then stop
 * comparing with new ones.
 */
export const workloadVersion = 1;
/** Every option that changes the numbers, at the values the baseline is measured with. */
export const standardOptions = {
  seedThreads: 400,
  settleMs: 10_000,
  idleMs: 60_000,
  newThreads: 20,
  sameThreadTurns: 40,
  longTextTurns: 3,
  longTextDeltas: 1_000,
  // About a fast model's pace. Much faster and how many deltas share a write-buffer flush
  // depends on machine load, which makes long-text CPU and transactions noisy.
  deltaMs: 10,
  speed: 20,
};
export type WorkloadOptions = typeof standardOptions;
/** Recordings each run replays, relative to the fake CLI's recordings directory. */
export const replayedFixtures = ["tool-read.jsonl"];

/** What a run measured: the same identity is the precondition for comparing two runs. */
export const Workload = z.object({
  version: z.number().int().positive(),
  options: z.record(z.string(), z.number()),
  /** SHA-256 of each replayed recording, by file name. */
  fixtures: z.record(z.string(), z.string()),
});
export type Workload = z.infer<typeof Workload>;

export async function fixtureDigests(directory: string): Promise<Record<string, string>> {
  const entries = await Promise.all(
    replayedFixtures.map(async (name) => {
      const bytes = await readFile(join(directory, name));
      return [name, createHash("sha256").update(bytes).digest("hex")] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/** Each field where `actual` differs from `expected`, as `name expected → actual`. */
export function workloadDifferences(expected: Workload, actual: Workload): string[] {
  const out: string[] = [];
  if (expected.version !== actual.version)
    out.push(`version ${expected.version} → ${actual.version}`);
  for (const [group, left, right] of [
    ["", expected.options, actual.options],
    ["fixture ", expected.fixtures, actual.fixtures],
  ] as const) {
    const names = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const name of [...names].toSorted()) {
      const a = left[name];
      const b = right[name];
      if (a === b) continue;
      const show = (value: string | number | undefined) =>
        value === undefined ? "(none)" : group ? String(value).slice(0, 12) : String(value);
      out.push(`${group}${name} ${show(a)} → ${show(b)}`);
    }
  }
  return out;
}

export class WorkloadMismatch extends Error {
  readonly differences: readonly string[];
  constructor(context: string, differences: readonly string[]) {
    super(`${context}: ${differences.join(", ")}`);
    this.differences = differences;
  }
}
/** Throws unless both describe the same workload. */
export function requireSameWorkload(context: string, expected: Workload, actual: Workload) {
  const differences = workloadDifferences(expected, actual);
  if (differences.length) throw new WorkloadMismatch(context, differences);
}
