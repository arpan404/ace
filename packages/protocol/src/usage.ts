import { z } from "zod";

const id = z.string().min(1).max(512);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dollars = z.number().nonnegative().max(1e12);
export const UsageMetadata = z.object({
  reasoningTokens: tokens.optional(),
  cacheWriteTokens: tokens.optional(),
  cacheWrite1hTokens: tokens.optional(),
  model: id.optional(),
  accountId: id.optional(),
  billingMode: z.enum(["api", "subscription", "unknown"]).optional(),
  counterMode: z.enum(["cumulative", "incremental"]).optional(),
  counterKey: id.optional(),
});
export type UsageMetadata = z.infer<typeof UsageMetadata>;
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
    filters: z.partialRecord(UsageDimension, z.array(id).min(1).max(50)).default({}),
    agentTree: id.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    orderBy: z.enum(["tokens", "cost"]).default("tokens"),
    equivalentApiCost: z.boolean().default(false),
    quotaAccount: id.optional(),
  })
  .refine(
    (q) => {
      const span = Date.parse(q.to) - Date.parse(q.from);
      return span >= 0 && span <= 365 * 86_400_000 && new Set(q.groupBy).size === q.groupBy.length;
    },
    { message: "Expected unique groups and an inclusive range of at most 366 days" },
  );
export type UsageQuery = z.infer<typeof UsageQuery>;
export const UsageTotals = z.object({
  inputTokens: tokens,
  outputTokens: tokens,
  cachedInputTokens: tokens,
  reasoningTokens: tokens,
  cacheWriteTokens: tokens,
  cacheWrite1hTokens: tokens,
  providerReportedUsd: dollars,
  estimatedUsd: dollars,
  equivalentApiUsd: dollars.nullable(),
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
  perHour: z.number().nonnegative(),
  remaining: z.number().nonnegative().nullable(),
  exhaustionAt: z.number().nonnegative().nullable(),
});
export type UsageBurn = z.infer<typeof UsageBurn>;
export const UsageResult = z.object({
  cursor: tokens,
  timezone: id,
  priceVersion: id,
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
