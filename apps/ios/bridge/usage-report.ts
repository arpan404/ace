import type { ClientCore } from "@ace/client";
import { ProviderKind, UsageQuery, type UsageDimension, type UsageResult } from "@ace/protocol";
import {
  catalogModelIds,
  catalogModelNames,
  dayRange,
  knownTimeZone,
  previousSpan,
  providerNames,
  readModelCatalog,
  usageDay,
  usageReport,
  type ModelCatalog,
} from "@ace/ui-core";
import { z } from "zod";
import { host } from "./host.ts";
import { usageMetricView, type UsageMetricView } from "./usage-report-view.ts";

/*
 * The Usage screen's Cost and Tokens views: the range's usage per day, model and session, and
 * the period before it for growth, read from the machine and worded by `usage-report-view.ts`.
 */

export const UsageReportRequest = z.object({
  type: z.literal("usage.report"),
  days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]),
  /** One provider's usage; every provider when absent. */
  provider: z.string().min(1).max(64).optional(),
});
export type UsageReportRequest = z.infer<typeof UsageReportRequest>;

export interface UsageReportReply {
  type: "usage.report";
  from: string;
  to: string;
  /** The providers that have usage or accounts here, for the provider filter. */
  providers: { id: string; name: string }[];
  tokens: UsageMetricView;
  cost: UsageMetricView;
}

const quiet = 15_000;

const providerName = (id: string) => {
  const kind = ProviderKind.safeParse(id);
  return kind.success ? providerNames[kind.data] : id;
};

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

/** The zone the machine counts usage days in; the phone's own when it can't say. */
async function usageZone(owner: ClientCore, signal: AbortSignal): Promise<string | undefined> {
  const probe = { from: "2026-01-01", to: "2026-01-01" };
  const result = await rows(owner, "usage.summary", probe, [], undefined, signal);
  return knownTimeZone(result.timezone);
}

export async function readUsageReport(
  owner: ClientCore,
  request: UsageReportRequest,
  signal: AbortSignal,
): Promise<UsageReportReply> {
  const catalogRead = readModelCatalog(owner, {}, signal).catch((): ModelCatalog => ({
    models: [],
    instances: [],
  }));
  const zone = await usageZone(owner, signal);
  const now = host.now();
  const span = { from: usageDay(now, zone, request.days - 1), to: usageDay(now, zone) };
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
  const modelName = catalogModelNames(catalog.models);
  const names = {
    provider: providerName,
    model: (provider: string, model: string) => modelName(provider, model),
  };
  const report = usageReport(
    [
      {
        daily: daily.rows,
        models: models.rows,
        threads: threads.rows,
        threadsTruncated: threads.truncated,
      },
    ],
    dayRange(span.from, span.to),
    (provider, model) => canonical(provider, model) ?? model,
  );
  const previous = usageReport(
    [{ daily: earlier.rows, models: [], threads: [], threadsTruncated: false }],
    dayRange(before.from, before.to),
  );
  const listed = [
    ...new Set(
      everyone.rows
        .map((row) => row.dimensions.provider)
        .filter((id) => id !== undefined && id !== null),
    ),
  ];
  return {
    type: "usage.report",
    ...span,
    providers: listed.map((id) => ({ id, name: providerName(id) })),
    tokens: usageMetricView(report, previous, request.days, "tokens", names),
    cost: usageMetricView(report, previous, request.days, "cost", names),
  };
}
