import { z } from "zod";
import bundled from "./prices.json" with { type: "json" };
const rate = z.number().nonnegative().max(1e6);
export const ModelPrice = z.object({
  source: z.url().optional(),
  asOf: z.iso.date().optional(),
  input: rate,
  cached: rate,
  write: rate,
  write1h: rate,
  output: rate,
});
export const PriceTable = z.object({
  version: z.string().min(1).max(128),
  asOf: z.iso.date().optional(),
  sources: z.array(z.url()).max(100),
  models: z
    .record(z.string().min(1).max(8192), ModelPrice)
    .refine((m) => Object.keys(m).length <= 1000),
});
export type PriceTable = z.infer<typeof PriceTable>;
export const defaultPrices = PriceTable.parse(bundled);
export const UsageSettings = z.object({
  /** Daily history is retained by event time, independent of replay batch boundaries. */
  retentionDays: z.number().int().min(1).max(3660).default(366),
  incrementRetentionDays: z.number().int().min(1).max(3660).default(35),
  timezone: z
    .string()
    .min(1)
    .max(128)
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions();
        return true;
      } catch {
        return false;
      }
    })
    .default("UTC"),
  prices: PriceTable.default(defaultPrices),
  priceOverrides: z
    .record(z.string().min(1).max(8192), ModelPrice)
    .default({})
    .refine((m) => Object.keys(m).length <= 1000),
  overrideVersion: z.string().min(1).max(128).default("local"),
});
export type UsageSettings = z.infer<typeof UsageSettings>;
export function resolvePrices(settings: UsageSettings): PriceTable {
  return {
    ...settings.prices,
    version: Object.keys(settings.priceOverrides).length
      ? `${settings.prices.version}/${settings.overrideVersion}`
      : settings.prices.version,
    models: { ...settings.prices.models, ...settings.priceOverrides },
  };
}
export function dayFormatter(timezone: string): (at: number) => string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (at) => {
    let year = "",
      month = "",
      day = "";
    for (const part of formatter.formatToParts(at)) {
      if (part.type === "year") year = part.value;
      else if (part.type === "month") month = part.value;
      else if (part.type === "day") day = part.value;
    }
    return `${year}-${month}-${day}`;
  };
}
