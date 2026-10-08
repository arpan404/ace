import type { Counts } from "./counters.ts";
export { defaultPrices } from "./settings.ts";
import { defaultPrices, type PriceTable } from "./settings.ts";

/** Input includes cache reads/writes; output includes reasoning. Subsets are never added twice. */
export function estimateTokens(
  counts: Counts,
  model: string,
  prices: PriceTable = defaultPrices,
): number | null {
  const price = prices.models[model];
  if (!price) return null;
  return (
    ((counts.input - counts.cached - counts.write) * price.input +
      counts.cached * price.cached +
      (counts.write - counts.write1h) * price.write +
      counts.write1h * price.write1h +
      counts.output * price.output) /
    1_000_000
  );
}
