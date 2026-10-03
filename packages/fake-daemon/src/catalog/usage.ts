import type { UsageDimension, UsageQuery, UsageResult, UsageRow, UsageTotals } from "@ace/protocol";

interface Source {
  provider: string;
  account: string;
  model: string;
  /** Typical daily input tokens; output is a fixed share of it. */
  daily: number;
  usdPerMillion: number;
  billing: "subscription" | "api";
}

const sources: readonly Source[] = [
  {
    provider: "claude",
    account: "claude-personal",
    model: "claude-opus-4-6",
    daily: 4_200_000,
    usdPerMillion: 15,
    billing: "subscription",
  },
  {
    provider: "claude",
    account: "claude-work",
    model: "claude-sonnet-4-6",
    daily: 2_600_000,
    usdPerMillion: 3,
    billing: "subscription",
  },
  {
    provider: "codex",
    account: "codex-personal",
    model: "gpt-5.3-codex",
    daily: 3_100_000,
    usdPerMillion: 5,
    billing: "subscription",
  },
  {
    provider: "opencode",
    account: "opencode-api",
    model: "kimi-k2",
    daily: 700_000,
    usdPerMillion: 0.6,
    billing: "api",
  },
];

const dayMs = 86_400_000;

/** Deterministic weekday-heavy wave, so the chart looks like a working fortnight. */
function factor(dayIndex: number, sourceIndex: number): number {
  const weekday = new Date(dayIndex * dayMs).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 0.25 : 1;
  const wave = 0.65 + 0.35 * Math.abs(Math.sin(dayIndex * 1.7 + sourceIndex * 2.3));
  return weekend * wave;
}

function totals(input: number, source: Source): UsageTotals {
  const output = Math.round(input * 0.18);
  const cached = Math.round(input * 0.55);
  const usd = ((input + output * 4) / 1_000_000) * source.usdPerMillion;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    reasoningTokens: Math.round(output * 0.4),
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    providerReportedUsd: source.billing === "api" ? usd : 0,
    estimatedUsd: usd,
    equivalentApiUsd: usd,
    overflow: false,
    unpricedTokens: 0,
    subscriptionTokens: source.billing === "subscription" ? input + output : 0,
    unknownBillingTokens: 0,
  };
}

function add(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    providerReportedUsd: a.providerReportedUsd + b.providerReportedUsd,
    estimatedUsd: a.estimatedUsd + b.estimatedUsd,
    equivalentApiUsd: (a.equivalentApiUsd ?? 0) + (b.equivalentApiUsd ?? 0),
    overflow: a.overflow || b.overflow,
    unpricedTokens: a.unpricedTokens + b.unpricedTokens,
    subscriptionTokens: a.subscriptionTokens + b.subscriptionTokens,
    unknownBillingTokens: a.unknownBillingTokens + b.unknownBillingTokens,
  };
}

/**
 * Answers a `usage.series` / `usage.summary` query from a fixed set of accounts and models.
 * Supports grouping by day, provider, account and model; other dimensions group as null.
 */
export function usageReport(query: UsageQuery): UsageResult {
  const from = Math.floor(Date.parse(query.from) / dayMs);
  const to = Math.floor(Date.parse(query.to) / dayMs);
  const groups = new Map<string, UsageRow>();
  for (let dayIndex = from; dayIndex <= to; dayIndex++) {
    const date = new Date(dayIndex * dayMs).toISOString().slice(0, 10);
    sources.forEach((source, index) => {
      const values: Partial<Record<UsageDimension, string | null>> = {
        day: date,
        provider: source.provider,
        account: source.account,
        model: source.model,
      };
      const filtered = Object.entries(query.filters).some(
        ([dimension, allowed]) =>
          allowed && !allowed.includes(values[dimension as UsageDimension] ?? ""),
      );
      if (filtered) return;
      const input = Math.round(source.daily * factor(dayIndex, index));
      const dimensions = Object.fromEntries(
        query.groupBy.map((dimension) => [dimension, values[dimension] ?? null]),
      );
      const key = JSON.stringify(dimensions);
      const row = groups.get(key);
      const next = totals(input, source);
      groups.set(
        key,
        row ? { dimensions, totals: add(row.totals, next) } : { dimensions, totals: next },
      );
    });
  }
  const rows = [...groups.values()];
  const value = (row: UsageRow) =>
    query.orderBy === "cost"
      ? row.totals.estimatedUsd
      : row.totals.inputTokens + row.totals.outputTokens;
  if (!query.groupBy.includes("day")) rows.sort((a, b) => value(b) - value(a));
  return {
    cursor: 0,
    omittedEvents: 0,
    timezone: "UTC",
    priceVersion: "fake-2026-10",
    rows: rows.slice(0, query.limit),
    truncated: rows.length > query.limit,
  };
}
