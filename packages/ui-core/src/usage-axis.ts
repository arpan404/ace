import { formatTokens } from "./usage-cost.ts";

/*
 * The Usage chart's y axis: round steps (1, 2, 2.5 or 5 × a power of ten) from zero to the
 * first tick at or above the peak, labelled compactly: "$0, $25, $50", "0, 50M, 100M".
 */

export type UsageAxisUnit = "tokens" | "usd";

export interface UsageAxis {
  /** Zero first, the top last; the chart's scale ends at the top. */
  ticks: { value: number; label: string }[];
  top: number;
}

const steps = [1, 2, 2.5, 5, 10];

/** The smallest round step that reaches `peak` in `intervals` steps. */
function niceStep(peak: number, intervals: number): number {
  const raw = peak / intervals;
  const power = 10 ** Math.floor(Math.log10(raw));
  const mantissa = steps.find((step) => step * power >= raw * (1 - 1e-9)) ?? 10;
  return mantissa * power;
}

/** A tick's compact figure: like `formatTokens`, but 2_500 reads "2.5K", never "3K". */
function compact(value: number): string {
  if (value >= 1e3 && value < 1e6 && value % 1e3 !== 0) return `${Math.round(value / 100) / 10}K`;
  return formatTokens(value);
}

/** Decimal places that show `step` exactly, up to four. */
function places(step: number): number {
  for (let digits = 0; digits < 4; digits++) {
    const scaled = step * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return digits;
  }
  return 4;
}

/** "$0", "$25", "$2.50", "$0.05", "$2.5K": whole dollars when the step is, cents only when needed. */
function dollars(value: number, step: number): string {
  if (value === 0) return "$0";
  if (value >= 1000) return `$${compact(value)}`;
  const digits = places(step);
  return `$${value.toFixed(digits === 0 ? 0 : Math.max(2, digits))}`;
}

/** The axis for a chart whose highest point is `peak`, in `intervals` round steps. */
export function usageAxis(peak: number, unit: UsageAxisUnit, intervals = 2): UsageAxis {
  if (!(peak > 0)) {
    return { ticks: [{ value: 0, label: unit === "usd" ? "$0" : "0" }], top: 1 };
  }
  const step = niceStep(peak, intervals);
  const count = Math.max(1, Math.ceil(peak / step - 1e-9));
  const ticks = Array.from({ length: count + 1 }, (_, index) => {
    // Rounded to the step's precision, so 3 × 0.1 reads 0.3, never 0.30000000000000004.
    const value = Number((index * step).toPrecision(12));
    return { value, label: unit === "usd" ? dollars(value, step) : compact(value) };
  });
  return { ticks, top: ticks.at(-1)?.value ?? step };
}
