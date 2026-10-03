import type { SQLOutputValue } from "node:sqlite";
const dollarFields = new Set(["estimatedUsd", "equivalentApiUsd", "providerReportedUsd"]);
/** SQLite REAL aggregation avoids integer SUM overflow. Wire totals saturate explicitly. */
export function boundedTotals(
  input: Record<string, SQLOutputValue>,
): Record<string, number | boolean> & { overflow: boolean } {
  const values: Record<string, number | boolean> = {};
  let overflow = false;
  for (const [key, value] of Object.entries(input)) {
    const n = Number(value);
    const limit = dollarFields.has(key) ? Number.MAX_VALUE : Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(n) || Math.abs(n) > limit) overflow = true;
    values[key] = Number.isNaN(n) ? 0 : Math.max(-limit, Math.min(limit, n));
  }
  return { ...values, overflow };
}
