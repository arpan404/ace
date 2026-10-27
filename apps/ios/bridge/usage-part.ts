import type { ClientCore } from "@ace/client";
import { UsageQuery, UsageRow, type UsageDimension, type UsageResult } from "@ace/protocol";
import {
  catalogModelIds,
  catalogModelNames,
  knownTimeZone,
  previousSpan,
  readModelCatalog,
  usageDay,
  type ModelCatalog,
} from "@ace/ui-core";
import { z } from "zod";
import { host } from "./host.ts";

/*
 * One machine's share of the Usage screen's Cost and Tokens views: its rows over the range and
 * the period before, with models already under their catalog ids and names. Swift gathers one
 * part from every machine in scope and hands them to `usage.combine` (`usage-report.ts`), so
 * the figures add up in shared code, never in Swift.
 */

const Day = z.iso.date();
const Days = z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]);

export const UsagePartRequest = z.object({
  type: z.literal("usage.part"),
  days: Days,
  /** One provider's usage; every provider when absent. */
  provider: z.string().min(1).max(64).optional(),
  /** The days the first machine counts, so every machine counts the same ones. */
  from: Day.optional(),
  to: Day.optional(),
});
export type UsagePartRequest = z.infer<typeof UsagePartRequest>;

const Rows = z.array(UsageRow).max(1000);
export const UsagePart = z.object({
  type: z.literal("usage.part"),
  from: Day,
  to: Day,
  daily: Rows,
  models: Rows,
  threads: Rows,
  threadsTruncated: z.boolean(),
  /** The period before, per day and provider, for growth. */
  previous: Rows,
  /** The providers with usage here in the range, for the provider filter. */
  providers: z.array(z.string().min(1).max(64)).max(64),
  /** The machine's catalog names for the models in `models`. */
  modelNames: z
    .array(
      z.object({
        provider: z.string().max(64),
        model: z.string().max(256),
        name: z.string().max(256),
      }),
    )
    .max(1000),
});
export type UsagePart = z.infer<typeof UsagePart>;

const quiet = 15_000;

async function rows(
  owner: ClientCore,
  kind: "usage.summary" | "usage.series",
  span: { from: string; to: string },
  groupBy: UsageDimension[],
  provider: string | undefined,
  signal: AbortSignal,
): Promise<UsageResult> {
  const query = UsageQuery.parse({
    ...span,
    groupBy,
    filters: provider ? { provider: [provider] } : {},
    equivalentApiCost: true,
    limit: 1000,
  });
  const reply = await owner.request(
    { type: kind, query, requestId: host.uuid() },
    { signal, timeoutMs: quiet },
  );
  return reply.result;
}

/** The days the machine counts the range over, in its own zone (the phone's when it can't say). */
async function machineSpan(owner: ClientCore, days: number, signal: AbortSignal) {
  const probe = { from: "2026-01-01", to: "2026-01-01" };
  const zone = knownTimeZone(
    (await rows(owner, "usage.summary", probe, [], undefined, signal)).timezone,
  );
  const now = host.now();
  return { from: usageDay(now, zone, days - 1), to: usageDay(now, zone) };
}

export async function readUsagePart(
  owner: ClientCore,
  request: UsagePartRequest,
  signal: AbortSignal,
): Promise<UsagePart> {
  const catalogRead = readModelCatalog(owner, {}, signal).catch((): ModelCatalog => ({
    models: [],
    instances: [],
  }));
  const span =
    request.from && request.to && request.from <= request.to
      ? { from: request.from, to: request.to }
      : await machineSpan(owner, request.days, signal);
  const before = previousSpan(span.from, span.to);
  const only = request.provider;
  const [daily, models, threads, earlier, everyone, catalog] = await Promise.all([
    rows(owner, "usage.series", span, ["day", "provider"], only, signal),
    rows(owner, "usage.summary", span, ["model", "provider"], only, signal),
    rows(owner, "usage.summary", span, ["thread", "provider"], only, signal),
    rows(owner, "usage.series", before, ["day", "provider"], only, signal),
    rows(owner, "usage.summary", span, ["provider"], undefined, signal),
    catalogRead,
  ]);
  const canonical = catalogModelIds(catalog.models);
  const name = catalogModelNames(catalog.models);
  const named = new Map<string, { provider: string; model: string; name: string }>();
  const modelRows = models.rows.map((row) => {
    const provider = row.dimensions.provider ?? "other";
    const reported = row.dimensions.model ?? "";
    const model = canonical(provider, reported) ?? reported;
    named.set(`${provider}\0${model}`, { provider, model, name: name(provider, model) });
    return { totals: row.totals, dimensions: { provider, model } };
  });
  return {
    type: "usage.part",
    ...span,
    daily: daily.rows,
    models: modelRows,
    threads: threads.rows,
    threadsTruncated: threads.truncated,
    previous: earlier.rows,
    providers: [
      ...new Set(
        everyone.rows.flatMap((row) => (row.dimensions.provider ? [row.dimensions.provider] : [])),
      ),
    ],
    modelNames: [...named.values()],
  };
}
