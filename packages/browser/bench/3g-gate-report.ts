/*
 * The M2b merge bar and the clean-run report for `3g-gate.ts`. Pure: runs in, verdicts and a
 * markdown table out.
 */

export type GateProfile = "phone" | "3g-1600" | "3g-400";

/** What `video-link.ts` prints, as far as the gate reads it. */
export interface LinkResult {
  median: number;
  p10: number;
  megabitsPerSecond: number;
  codedWidth: number | null;
  glassToGlassMs: { p50: number | null; p95: number | null };
}

export interface GateRun {
  profile: GateProfile;
  startedAt: string;
  /** The highest 1-minute load average sampled during the run. */
  maxLoad: number;
  result: LinkResult;
}

export interface GateRow extends GateRun {
  bar: string;
  met: boolean;
}

export interface GateReport {
  maxLoad: number;
  deadline: string;
  finishedAt: string;
  rows: GateRow[];
  /** Runs thrown away because the load went over `maxLoad` during them. */
  discarded: { profile: GateProfile; startedAt: string; maxLoad: number }[];
  /** Profiles that never got a clean run before the deadline. */
  missing: GateProfile[];
}

/** The order the gate runs them in. */
export const gateProfiles: readonly GateProfile[] = ["phone", "3g-1600", "3g-400"];

/** The M2b merge bar, per profile: what it asks, and whether a result meets it. */
export const gateBars: Record<GateProfile, { bar: string; meets(result: LinkResult): boolean }> = {
  phone: {
    bar: "about 60 fps: median ≥ 58, p10 ≥ 55",
    meets: (result) => result.median >= 58 && result.p10 >= 55,
  },
  "3g-1600": {
    bar: "≥ 15 fps median, ≥ 1152 px wide, glass-to-glass p50 ≤ 1 s",
    meets: (result) =>
      result.median >= 15 &&
      (result.codedWidth ?? 0) >= 1152 &&
      (result.glassToGlassMs.p50 ?? Infinity) <= 1_000,
  },
  "3g-400": {
    bar: "glass-to-glass p50 ≤ 1.5 s",
    meets: (result) => (result.glassToGlassMs.p50 ?? Infinity) <= 1_500,
  },
};

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The fields the gate reads from a `video-link.ts` result line; undefined if it isn't one. */
export function linkResult(value: unknown): LinkResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const line = value as Record<string, unknown>;
  const median = finite(line.median);
  const p10 = finite(line.p10);
  const megabitsPerSecond = finite(line.megabitsPerSecond);
  if (median === null || p10 === null || megabitsPerSecond === null) return undefined;
  const lag =
    typeof line.glassToGlassMs === "object" && line.glassToGlassMs !== null
      ? (line.glassToGlassMs as Record<string, unknown>)
      : {};
  return {
    median,
    p10,
    megabitsPerSecond,
    codedWidth: finite(line.codedWidth),
    glassToGlassMs: { p50: finite(lag.p50), p95: finite(lag.p95) },
  };
}

export function gateRow(run: GateRun): GateRow {
  const { bar, meets } = gateBars[run.profile];
  return { ...run, bar, met: meets(run.result) };
}

const cell = (value: number | null | undefined, unit = "") =>
  value === null || value === undefined ? "—" : `${value}${unit}`;

export function gateMarkdown(report: GateReport): string {
  const lines = [
    "# 3G bench gate",
    "",
    `Clean runs only: the 1-minute load stayed below ${report.maxLoad} for the whole run. Finished ${report.finishedAt} (deadline ${report.deadline}).`,
    "",
    "| Profile | Started | Max load | fps median / p10 | Mbit/s | Width | Glass to glass p50 / p95 | Bar | Met |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.rows.map(
      (row) =>
        `| ${row.profile} | ${row.startedAt} | ${row.maxLoad.toFixed(1)} | ${row.result.median} / ${row.result.p10} | ${row.result.megabitsPerSecond} | ${cell(row.result.codedWidth)} | ${cell(row.result.glassToGlassMs.p50, " ms")} / ${cell(row.result.glassToGlassMs.p95, " ms")} | ${row.bar} | ${row.met ? "yes" : "**no**"} |`,
    ),
    "",
  ];
  if (report.missing.length)
    lines.push(`No clean run before the deadline: ${report.missing.join(", ")}.`, "");
  if (report.discarded.length)
    lines.push(
      `Discarded (load went over ${report.maxLoad} during the run): ${report.discarded
        .map((run) => `${run.profile} at ${run.startedAt} (max ${run.maxLoad.toFixed(1)})`)
        .join("; ")}.`,
      "",
    );
  return lines.join("\n");
}
