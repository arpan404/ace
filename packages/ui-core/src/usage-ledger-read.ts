import type { UsageDimension, UsageRow } from "@ace/protocol";
import { ledgerTop, type LedgerGroup, type LedgerRead } from "./usage-ledger.ts";
import { previousSpan } from "./usage-growth.ts";

/*
 * One machine's reads for a ledger group: its totals per value, the same span before (for each
 * row's change) and days for the top values (for trends). Machines are the ledger's own group:
 * one row each, from its day series. The query itself is the caller's, so web and the phone
 * read the same way over their own clients.
 */

export type LedgerFilters = Partial<Record<UsageDimension, string[]>>;

/** Asks one machine for usage rows: a summary, or a series per day. */
export type LedgerQuery = (
  kind: "summary" | "series",
  span: { from: string; to: string },
  groupBy: UsageDimension[],
  filters: LedgerFilters,
  limit: number,
) => Promise<readonly UsageRow[]>;

/** Values read per machine before ranking; the ledger shows the top ones and "Show all". */
export const ledgerValueLimit = 200;

export async function readLedgerGroup(
  query: LedgerQuery,
  span: { from: string; to: string },
  filters: LedgerFilters,
  group: LedgerGroup,
): Promise<LedgerRead> {
  const before = previousSpan(span.from, span.to);
  if (group === "machine") {
    const [series, previous] = await Promise.all([
      query("series", span, ["day"], filters, 1000),
      query("summary", before, [], filters, 1),
    ]);
    return { totals: series, previous, series };
  }
  // Models are read with their provider, so a legacy bare id and its provider-prefixed one can be
  // named as one catalog model before they are summed.
  const by: UsageDimension[] = group === "model" ? ["model", "provider"] : [group];
  const totals = await query("summary", span, by, filters, ledgerValueLimit);
  // Days and the span before only for the values that can show; the rest rank by totals alone.
  const top = [...new Set(totals.flatMap((row) => row.dimensions[group] ?? []))].slice(0, 50);
  if (!top.length) return { totals, previous: [], series: [] };
  const shown = { ...filters, [group]: top };
  const trended = { ...filters, [group]: top.slice(0, ledgerTop) };
  const [previous, series] = await Promise.all([
    query("summary", before, by, shown, ledgerValueLimit),
    query("series", span, ["day", ...by], trended, 1000),
  ]);
  return { totals, previous, series };
}

/** Every row's model under its catalog id, so one model is one ledger row. */
export function canonicalLedgerRead(
  read: LedgerRead,
  canonical: (provider: string, model: string) => string,
): LedgerRead {
  const name = (rows: readonly UsageRow[]) =>
    rows.map((row) => {
      const model = row.dimensions.model;
      if (!model) return row;
      const id = canonical(row.dimensions.provider ?? "", model);
      return id === model ? row : { ...row, dimensions: { ...row.dimensions, model: id } };
    });
  return { totals: name(read.totals), previous: name(read.previous), series: name(read.series) };
}
