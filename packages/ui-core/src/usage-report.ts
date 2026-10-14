import type { UsageRow, UsageTotals } from "@ace/protocol";

/*
 * The Usage page's Tokens and Cost views from the daemons' usage rows, summed across the
 * environments shown. Money is the API estimate: what the tokens would cost at list API prices.
 * A model ace has no price for is "unpriced", never a zero.
 */

/** One environment's rows over the range. */
export interface EnvironmentUsage {
  /** `usage.series` grouped by provider: one row per day and provider. */
  daily: readonly UsageRow[];
  /** `usage.summary` grouped by model and provider. */
  models: readonly UsageRow[];
  /** `usage.summary` grouped by thread and provider: one row per session. */
  threads: readonly UsageRow[];
  /** More sessions than one read returns, so the count is a floor. */
  threadsTruncated: boolean;
}

export interface ProviderUsage {
  provider: string;
  tokens: number;
  usd: number;
  unpricedTokens: number;
  sessions: number;
}

export interface DayUsage {
  day: string;
  tokens: number;
  usd: number;
  byProvider: ReadonlyMap<string, { tokens: number; usd: number }>;
}

export interface ModelUsage {
  key: string;
  model: string;
  provider: string;
  tokens: number;
  /** Null when ace has no price for the model. */
  usd: number | null;
}

export interface TokenTypes<T> {
  input: T;
  cacheRead: T;
  cacheWrite: T;
  output: T;
}

export interface UsageReport {
  tokens: number;
  usd: number;
  unpricedTokens: number;
  /** What providers themselves reported charging (OpenCode does per step). */
  reportedUsd: number;
  sessions: number;
  sessionsCapped: boolean;
  providers: ProviderUsage[];
  days: DayUsage[];
  tokenTypes: TokenTypes<number>;
  costTypes: TokenTypes<number>;
  cachedInput: number;
  uncachedInput: number;
  cacheSavingsUsd: number;
  models: ModelUsage[];
}

const dayMs = 86_400_000;

/** Every calendar day from `from` to `to`, inclusive ("2026-10-01" … "2026-10-07"). */
export function dayRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: string[] = [];
  for (let at = start; at <= end && days.length < 400; at += dayMs)
    days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

/** Input and output; input already includes cache reads and writes. */
export const usageTokens = (totals: UsageTotals) => totals.inputTokens + totals.outputTokens;

const split = (totals: UsageTotals) =>
  totals.apiInputUsd === undefined &&
  totals.apiCacheReadUsd === undefined &&
  totals.apiCacheWriteUsd === undefined &&
  totals.apiOutputUsd === undefined
    ? undefined
    : {
        input: totals.apiInputUsd ?? 0,
        cacheRead: totals.apiCacheReadUsd ?? 0,
        cacheWrite: totals.apiCacheWriteUsd ?? 0,
        output: totals.apiOutputUsd ?? 0,
      };

/** The API estimate of the priced part of `totals`. */
export function pricedUsd(totals: UsageTotals): number {
  const parts = split(totals);
  if (parts) return parts.input + parts.cacheRead + parts.cacheWrite + parts.output;
  return totals.equivalentApiUsd ?? 0;
}

/**
 * Sum the environments' rows over `days`. `canonical` names a model by its catalog id, so the
 * same model reported under an older bare id and a prefixed one counts as one.
 */
export function usageReport(
  environments: readonly EnvironmentUsage[],
  days: readonly string[],
  canonical: (provider: string, model: string) => string = (_provider, model) => model,
) {
  const providers = new Map<string, ProviderUsage>();
  const provider = (id: string) => {
    let entry = providers.get(id);
    if (!entry) {
      entry = { provider: id, tokens: 0, usd: 0, unpricedTokens: 0, sessions: 0 };
      providers.set(id, entry);
    }
    return entry;
  };
  type Day = {
    day: string;
    tokens: number;
    usd: number;
    byProvider: Map<string, { tokens: number; usd: number }>;
  };
  const byDay = new Map<string, Day>(
    days.map((day) => [day, { day, tokens: 0, usd: 0, byProvider: new Map() }]),
  );
  const report = {
    tokens: 0,
    usd: 0,
    unpricedTokens: 0,
    reportedUsd: 0,
    sessions: 0,
    sessionsCapped: false,
    tokenTypes: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    costTypes: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    cachedInput: 0,
    uncachedInput: 0,
    cacheSavingsUsd: 0,
  };
  const models = new Map<string, ModelUsage & { unpriced: number }>();
  for (const environment of environments) {
    for (const row of environment.daily) {
      const totals = row.totals;
      const id = row.dimensions.provider ?? "other";
      const tokens = usageTokens(totals);
      const usd = pricedUsd(totals);
      const entry = provider(id);
      entry.tokens += tokens;
      entry.usd += usd;
      entry.unpricedTokens += totals.unpricedTokens;
      report.tokens += tokens;
      report.usd += usd;
      report.unpricedTokens += totals.unpricedTokens;
      report.reportedUsd += totals.providerReportedUsd;
      report.cachedInput += totals.cachedInputTokens;
      report.uncachedInput += totals.inputTokens - totals.cachedInputTokens;
      report.cacheSavingsUsd += totals.cacheSavingsUsd ?? 0;
      report.tokenTypes.input +=
        totals.inputTokens - totals.cachedInputTokens - totals.cacheWriteTokens;
      report.tokenTypes.cacheRead += totals.cachedInputTokens;
      report.tokenTypes.cacheWrite += totals.cacheWriteTokens;
      report.tokenTypes.output += totals.outputTokens;
      const parts = split(totals);
      if (parts) {
        report.costTypes.input += parts.input;
        report.costTypes.cacheRead += parts.cacheRead;
        report.costTypes.cacheWrite += parts.cacheWrite;
        report.costTypes.output += parts.output;
      }
      const day = byDay.get(row.dimensions.day ?? "");
      if (day) {
        day.tokens += tokens;
        day.usd += usd;
        const share = day.byProvider.get(id) ?? { tokens: 0, usd: 0 };
        day.byProvider.set(id, { tokens: share.tokens + tokens, usd: share.usd + usd });
      }
    }
    for (const row of environment.threads) {
      if (!row.dimensions.thread || usageTokens(row.totals) === 0) continue;
      provider(row.dimensions.provider ?? "other").sessions += 1;
      report.sessions += 1;
    }
    if (environment.threadsTruncated) report.sessionsCapped = true;
    for (const row of environment.models) {
      const id = row.dimensions.provider ?? "other";
      const model = canonical(id, row.dimensions.model ?? "");
      const key = `${id}\0${model}`;
      const entry = models.get(key) ?? {
        key,
        model,
        provider: id,
        tokens: 0,
        usd: 0,
        unpriced: 0,
      };
      entry.tokens += usageTokens(row.totals);
      entry.unpriced += row.totals.unpricedTokens;
      entry.usd = (entry.usd ?? 0) + pricedUsd(row.totals);
      models.set(key, entry);
    }
  }
  return {
    ...report,
    providers: [...providers.values()].filter((entry) => entry.tokens > 0 || entry.sessions > 0),
    days: [...byDay.values()],
    models: [...models.values()].map((entry): ModelUsage => ({
      key: entry.key,
      model: entry.model,
      provider: entry.provider,
      tokens: entry.tokens,
      usd: entry.unpriced >= entry.tokens && entry.tokens > 0 ? null : entry.usd,
    })),
  } satisfies UsageReport;
}

/** "12.4%", "<0.1%": a part of a whole; "0%" when the whole is empty. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const share = (part / whole) * 100;
  if (share < 0.1) return "<0.1%";
  return `${share.toFixed(1)}%`;
}
