/** 9_214_000 → "9.2M", 840_000 → "840K", 19_300_000_000 → "19.3B". */
export function formatTokens(value: number): string {
  // Each step is chosen after rounding, so 999_600 reads "1.0M", never "1000K".
  if (Math.round(value / 1e8) >= 10) return `${(value / 1e9).toFixed(1)}B`;
  if (Math.round(value / 1e5) >= 10) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.round(value) >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

/** Dollars, with cents shown down to a hundredth of a cent: "$412", "$4.82", "$0.0017". */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}
