/*
 * The ledger's reads: for the group shown, each machine's totals per value, the same span before
 * (for change), and days for the top values (for trends). Machines are the page's own group: one
 * row each, from its own day series. Reads go to each machine's own client, as the page's do.
 */
import type { ClientApi } from "@ace/client";
import { UsageQuery, type UsageDimension, type UsageRow } from "@ace/protocol";
import {
  dayRange,
  ledgerLines,
  ledgerTop,
  machineLedgerLines,
  previousSpan,
  type LedgerGroup,
  type LedgerLine,
  type LedgerRead,
} from "@ace/ui-core";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Machine } from "@/lib/machines.ts";
import type { UsageFilters, UsageSpan } from "./usage-data.ts";

/** Values read per machine before ranking; the ledger shows the top ones and "Show all". */
const valueLimit = 200;

async function query(
  client: ClientApi,
  kind: "summary" | "series",
  span: { from: string; to: string },
  groupBy: UsageDimension[],
  filters: UsageFilters,
  signal: AbortSignal,
  limit: number,
): Promise<readonly UsageRow[]> {
  const parsed = UsageQuery.parse({
    from: span.from,
    to: span.to,
    groupBy,
    filters,
    equivalentApiCost: true,
    orderBy: "cost",
    limit,
  });
  const type = kind === "series" ? "usage.series" : "usage.summary";
  return (await client.request({ type, query: parsed }, { signal })).result.rows;
}

async function readGroup(
  client: ClientApi,
  span: UsageSpan,
  filters: UsageFilters,
  group: LedgerGroup,
  signal: AbortSignal,
): Promise<LedgerRead> {
  const before = previousSpan(span.from, span.to);
  if (group === "machine") {
    const [series, previous] = await Promise.all([
      query(client, "series", span, ["day"], filters, signal, 1000),
      query(client, "summary", before, [], filters, signal, 1),
    ]);
    return { totals: series, previous, series };
  }
  // Models are read with their provider, so a legacy bare id and its provider-prefixed one can be
  // named as one catalog model before they are summed.
  const by: UsageDimension[] = group === "model" ? ["model", "provider"] : [group];
  const totals = await query(client, "summary", span, by, filters, signal, valueLimit);
  // Days and the span before only for the values that can show; the rest rank by totals alone.
  const top = [...new Set(totals.flatMap((row) => row.dimensions[group] ?? []))].slice(0, 50);
  if (!top.length) return { totals, previous: [], series: [] };
  const shown = { ...filters, [group]: top };
  const trended = { ...filters, [group]: top.slice(0, ledgerTop) };
  const [previous, series] = await Promise.all([
    query(client, "summary", before, by, shown, signal, valueLimit),
    query(client, "series", span, ["day", ...by], trended, signal, 1000),
  ]);
  return { totals, previous, series };
}

export interface LedgerResult {
  /** Undefined while loading, or when no machine in scope records this group. */
  lines: LedgerLine[] | undefined;
  loading: boolean;
}

/**
 * The ledger's lines for `group` within `filters`, summed over the machines given. A machine
 * whose daemon doesn't record the group (an older one, for skills) is left out, not counted as
 * zero; when none does, the lines are undefined.
 */
export function useLedger(
  machines: readonly Machine[],
  span: UsageSpan,
  filters: UsageFilters,
  group: LedgerGroup,
  /** A model's catalog id from its provider and reported id, so one model is one row. */
  canonicalModel?: (provider: string, model: string) => string,
): LedgerResult {
  const online = machines.filter((machine) => machine.client !== undefined);
  const reads = useQueries({
    queries: online.map((machine) => ({
      queryKey: ["usage-page", machine.id, "ledger", group, span.from, span.to, filters],
      enabled: span.ready,
      placeholderData: (previous: LedgerRead | null | undefined) => previous,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const client = machine.client;
        if (!client) throw new Error(`${machine.name} is offline`);
        try {
          return await readGroup(client, span, filters, group, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          return null;
        }
      },
    })),
  });
  const loading = reads.some((read) => read.data === undefined && !read.isError);
  const data = reads.map((read) => read.data);
  const days = useMemo(() => dayRange(span.from, span.to), [span.from, span.to]);
  // At most a few hundred rows per machine: summing them each render costs less than a memo.
  const named =
    group === "model" && canonicalModel
      ? data.map((read) => read && canonicalRead(read, canonicalModel))
      : data;
  return { lines: sumLines(online, named, group, days), loading };
}

/** Every row's model under its catalog id. */
function canonicalRead(
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

function sumLines(
  machines: readonly Machine[],
  data: readonly (LedgerRead | null | undefined)[],
  group: LedgerGroup,
  days: readonly string[],
): LedgerLine[] | undefined {
  if (data.some((read) => read === undefined)) return undefined;
  const answered = machines.flatMap((machine, index) => {
    const read = data[index];
    return read ? [{ key: machine.id, read }] : [];
  });
  if (!answered.length) return undefined;
  if (group === "machine") return machineLedgerLines(answered, days);
  return ledgerLines(
    answered.map((entry) => entry.read),
    group,
    days,
  );
}
