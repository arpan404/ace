import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { AccountSummary } from "./accounts.ts";

const id = z.string().min(1).max(512);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dollars = z.number().nonnegative();
const adjustment = z.number();
export { UsageCounter, UsageMetadata } from "./usage-core.ts";
export const UsageDimension = z.enum([
  "day",
  "thread",
  "agent",
  "provider",
  "account",
  "model",
  "workspace",
]);
export type UsageDimension = z.infer<typeof UsageDimension>;
const date = z.iso.date();
export const UsageQuery = z
  .object({
    from: date,
    to: date,
    groupBy: z.array(UsageDimension).max(7).default([]),
    filters: z
      .partialRecord(UsageDimension, z.array(z.string().min(1).max(8192)).min(1).max(50))
      .default({}),
    agentTree: id.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    orderBy: z.enum(["tokens", "cost"]).default("tokens"),
    equivalentApiCost: z.boolean().default(false),
    bucket: z.enum(["day", "week", "month"]).optional(),
    quotaAccount: id.optional(),
  })
  .refine(
    (q) => {
      const span = Date.parse(q.to) - Date.parse(q.from);
      return span >= 0 && span <= 365 * 86_400_000 && new Set(q.groupBy).size === q.groupBy.length;
    },
    { message: "Expected unique groups and an inclusive range of at most 366 days" },
  )
  .meta({
    "x-ace-constraint":
      "to >= from, their difference is <= 365 days, and groupBy entries are unique.",
    examples: [{ from: "2026-10-01", to: "2026-10-02" }],
  });
export type UsageQuery = z.infer<typeof UsageQuery>;
export const UsageTotals = z.object({
  inputTokens: tokens,
  outputTokens: tokens,
  cachedInputTokens: tokens,
  reasoningTokens: tokens,
  cacheWriteTokens: tokens,
  cacheWrite1hTokens: tokens,
  providerReportedUsd: dollars,
  estimatedUsd: adjustment,
  equivalentApiUsd: adjustment.nullable(),
  /** Saturation prevents unsafe token totals or non-finite aggregate dollars. */
  overflow: z.boolean().default(false),
  unpricedTokens: tokens,
  subscriptionTokens: tokens,
  unknownBillingTokens: tokens,
});
export type UsageTotals = z.infer<typeof UsageTotals>;
export const UsageRow = z.object({
  dimensions: z.partialRecord(UsageDimension, z.string().nullable()),
  totals: UsageTotals,
});
export type UsageRow = z.infer<typeof UsageRow>;
export const UsageBurn = z.object({
  windowId: id,
  unit: z.enum(["tokens", "usd"]),
  observed: z.number().nonnegative(),
  overflow: z.boolean().default(false),
  complete: z.boolean().default(true),
  perHour: z.number().nonnegative(),
  remaining: z.number().nonnegative().nullable(),
  exhaustionAt: z.number().nonnegative().nullable(),
});
export type UsageBurn = z.infer<typeof UsageBurn>;
export const UsageResult = z.object({
  cursor: tokens,
  omittedEvents: tokens.default(0),
  timezone: id,
  priceVersion: id,
  priceAsOf: date.optional(),
  priceSources: z.array(z.url()).max(100).optional(),
  costLabel: z.literal("estimate").optional(),
  tokenSource: z.literal("cli").optional(),
  retainedFrom: date.optional(),
  /** Current accounts matching provider/account filters, alongside historical rows. */
  accounts: z.array(AccountSummary).max(256).optional(),
  rows: z.array(UsageRow).max(1000),
  truncated: z.boolean(),
  burn: z.array(UsageBurn).max(20).optional(),
});
export type UsageResult = z.infer<typeof UsageResult>;
export const UsageSummary = z.object({
  type: z.literal("usage.summary"),
  requestId: id,
  query: UsageQuery,
});
export const UsageSeries = z.object({
  type: z.literal("usage.series"),
  requestId: id,
  query: UsageQuery,
});
export const UsageMessage = z.object({
  type: z.literal("usage.result"),
  requestId: id,
  kind: z.enum(["summary", "series"]),
  result: UsageResult,
});
export const UsageLimitsChanged = z.object({
  type: z.literal("usage.limits_changed"),
  account: AccountSummary,
});

export const UsageSessionTotal = z.object({
  counterKey: id,
  scope: z.enum(["provider_session", "model_session"]),
  model: z.string().max(8192),
  at: z.number().int().nonnegative(),
  inputTokens: tokens,
  outputTokens: tokens,
  cachedInputTokens: tokens,
  cacheWriteTokens: tokens,
  cacheWrite1hTokens: tokens.default(0),
  costUsd: dollars,
});
export const UsageSessionTotalPage = z.array(UsageSessionTotal).max(100);
export const UsageSessionTotalsQuery = z.object({
  thread: ThreadId.max(8192),
  limit: z.number().int().min(1).max(100).default(100),
});
export type UsageSessionTotalsQuery = z.infer<typeof UsageSessionTotalsQuery>;
export const UsageSessionTotals = z.object({
  type: z.literal("usage.session_totals"),
  requestId: id,
  query: UsageSessionTotalsQuery,
});
export const UsageSessionTotalsMessage = z.object({
  type: z.literal("usage.session_totals.result"),
  requestId: id,
  totals: UsageSessionTotalPage,
});
