import { matchModel } from "./litellm.ts";
import type { Counts } from "./counters.ts";
export { defaultPrices } from "./settings.ts";
import { defaultPrices, type PriceTable } from "./settings.ts";

/** Input includes cache reads/writes; output includes reasoning. Subsets are never added twice. */
export function estimateTokens(
  counts: Counts,
  model: string,
  prices: PriceTable = defaultPrices,
): number | null {
  const key = matchModel(model, prices.models);
  const price = key === undefined ? undefined : prices.models[key];
  if (!price) return null;
  return (
    ((counts.input - counts.cached - counts.write) * price.input +
      counts.cached * price.cached +
      (counts.write - counts.write1h) * price.write +
      counts.write1h * price.write1h +
      (counts.output - counts.reasoning) * price.output +
      counts.reasoning * (price.reasoning ?? price.output)) /
    1_000_000
  );
}
