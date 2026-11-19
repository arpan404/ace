import { usageGrowth } from "./usage-growth.ts";

/*
 * Figures on the Usage page, formatted one way everywhere: money to the scale of the period (whole
 * dollars once the period reaches $100, cents below), shares to one decimal, and change against
 * the period before in words, never a bare sign.
 */

/** Money for a page whose largest figure is `scale`: "$990", "$72" at $100 and up; "$4.27" below. */
export function usageMoney(scale: number): (value: number) => string {
  const whole = scale >= 100;
  const format = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
  return (value) => (value > 0 && !whole && value < 0.01 ? "<$0.01" : format.format(value));
}

/** "55.3%", "<0.1%", "0%": a share 0–1 to one decimal. */
export function usagePercent(share: number): string {
  if (!(share > 0)) return "0%";
  const percent = share * 100;
  return percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

/** "the previous 30 days", "yesterday": what a range is compared with. */
function before(days: number): string {
  return days <= 1 ? "yesterday" : `the previous ${days} days`;
}

/**
 * "6.6% less than the previous 30 days", "18.0% more than yesterday", "About the same as …",
 * "Nothing in the previous 30 days to compare"; undefined with nothing in either period.
 */
export function growthSentence(
  current: number,
  previous: number,
  days: number,
): string | undefined {
  const growth = usageGrowth(current, previous);
  if (growth.direction === "none") return undefined;
  if (growth.direction === "new") return `Nothing in ${before(days)} to compare`;
  if (growth.direction === "flat") return `About the same as ${before(days)}`;
  const ratio = current / previous;
  const size = ratio >= 10 ? `${Math.round(ratio)}×` : `${Math.abs((ratio - 1) * 100).toFixed(1)}%`;
  if (ratio >= 10) return `${size} ${before(days)}`;
  return `${size} ${growth.direction === "up" ? "more" : "less"} than ${before(days)}`;
}

const priceDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Where the page's prices come from, as one quiet line: "Prices from LiteLLM, updated Nov 1,
 * 2026". The newest price date across the machines read; undefined when none says.
 */
export function priceNote(
  reads: readonly { priceVersion?: string | undefined; priceAsOf?: string | undefined }[],
): string | undefined {
  const dated = reads.filter((read) => read.priceAsOf);
  const newest = dated.toSorted((a, b) => ((b.priceAsOf ?? "") > (a.priceAsOf ?? "") ? 1 : -1))[0];
  if (!newest?.priceAsOf) return undefined;
  const from = newest.priceVersion?.startsWith("litellm") ? "LiteLLM" : "ace's price table";
  const day = Date.parse(`${newest.priceAsOf}T00:00:00Z`);
  return `Prices from ${from}, updated ${Number.isNaN(day) ? newest.priceAsOf : priceDay.format(day)}`;
}
