import type { MarketResult } from "@ace/protocol/marketplace";
import { installedRow, updatesText } from "./market-rows.ts";

/*
 * What the machine has installed from the market, for the phone (spec items 16 to 21): updates
 * first, then everything else, each row with its words written. Pure. Slice #2502 shapes this
 * further.
 */

type Result<T extends MarketResult["op"]> = Extract<MarketResult, { op: T }>;

export function installedAnswer(result: Result<"installed">) {
  const rows = result.installed
    .map(installedRow)
    .toSorted(
      (a, b) =>
        Number(b.update !== null) - Number(a.update !== null) || a.title.localeCompare(b.title),
    );
  const updates = rows.filter((row) => row.update !== null).length;
  return { rows, updates, updatesText: updatesText(updates) };
}
