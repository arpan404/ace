import { dayRange } from "./usage-report.ts";

/*
 * Growth on the Usage page: a range's total against the same number of days just before it.
 * "up" and "down" carry a signed percent; a range after an empty one is "new", and two empty
 * ranges have nothing to compare ("none").
 */

export type UsageGrowthDirection = "up" | "down" | "flat" | "new" | "none";

export interface UsageGrowth {
  direction: UsageGrowthDirection;
  /** "+12%", "−3.4%", "No change", "New"; empty when there is nothing to compare. */
  label: string;
}

const dayMs = 86_400_000;
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The span of the same length that ends the day before `from` (inclusive days). */
export function previousSpan(from: string, to: string): { from: string; to: string } {
  const length = Math.max(1, dayRange(from, to).length);
  const start = Date.parse(`${from}T00:00:00Z`);
  return { from: isoDay(start - length * dayMs), to: isoDay(start - dayMs) };
}

/** "+4.2%" under 10%, "+38%" to 999%, "12×" beyond: a change read at a glance. */
function changeLabel(current: number, previous: number): string {
  const ratio = current / previous;
  if (ratio >= 10) return `${Math.round(ratio)}×`;
  const percent = (ratio - 1) * 100;
  const size = Math.abs(percent);
  const digits = size < 10 ? size.toFixed(1) : String(Math.round(size));
  return `${percent > 0 ? "+" : "−"}${digits}%`;
}

/** `current` against `previous`; a change under 0.05% reads as no change. */
export function usageGrowth(current: number, previous: number): UsageGrowth {
  if (previous <= 0)
    return current > 0 ? { direction: "new", label: "New" } : { direction: "none", label: "" };
  const percent = ((current - previous) / previous) * 100;
  if (Math.abs(percent) < 0.05) return { direction: "flat", label: "No change" };
  return { direction: percent > 0 ? "up" : "down", label: changeLabel(current, previous) };
}

/** "vs yesterday", "vs previous 7 days": what a growth label compares with. */
export function growthBasis(days: number): string {
  return days <= 1 ? "vs yesterday" : `vs previous ${days} days`;
}
