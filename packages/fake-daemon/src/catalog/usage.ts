import type {
  ServerMessage,
  UsageDimension,
  UsageQuery,
  UsageResult,
  UsageRow,
  UsageSessionTotalsQuery,
  UsageTotals,
} from "@ace/protocol";

/** One inclusive snapshot as `usage.session_totals` answers it. */
export type UsageSessionTotal = Extract<
  ServerMessage,
  { type: "usage.session_totals.result" }
>["totals"][number];

/** One account and model's daily usage, spread over the threads that ran on it. */
export interface UsageSource {
  provider: string;
  account: string;
  model: string;
  /** Typical daily input tokens; output is a quarter of it. */
  daily: number;
  /** The same tokens every day, without the working-week wave (tests). */
  steady?: boolean;
  /** ace's API list price per million tokens (input and output); null when it has no price. */
  apiUsdPerMillion: number | null;
  /** What the provider reports per step, per million tokens (OpenCode does; Claude doesn't). */
  reportedUsdPerMillion?: number;
  billing: "subscription" | "api";
  /** Threads of the development world that ran on this source, one per day in turn. */
  threads: readonly string[];
}

const sources: readonly UsageSource[] = [
  {
    provider: "claude",
    account: "claude-personal",
    model: "claude-opus-4-6",
    daily: 4_200_000,
    apiUsdPerMillion: 15,
    billing: "subscription",
    threads: [
      "thread-dedupe",
      "thread-retry-budget",
      "thread-resumable-streams",
      "thread-checkout",
    ],
  },
  {
    provider: "claude",
    account: "claude-work",
    model: "claude-sonnet-4-6",
    daily: 2_600_000,
    apiUsdPerMillion: 3,
    billing: "subscription",
    threads: ["thread-refund-tax", "thread-haptics", "thread-cold-start"],
  },
  {
    provider: "codex",
    account: "codex-personal",
    model: "gpt-5.3-codex",
    daily: 3_100_000,
    apiUsdPerMillion: 5,
    billing: "subscription",
    threads: ["thread-multi-day", "thread-sheet-rotate", "thread-bump-codex"],
  },
  {
    provider: "opencode",
    account: "opencode-api",
    model: "opencode/kimi-k2",
    daily: 700_000,
    apiUsdPerMillion: null,
    reportedUsdPerMillion: 0.6,
    billing: "api",
    threads: ["thread-router", "thread-install-page", "thread-fan-out"],
  },
];

const hour = 3_600_000;

/**
 * Claude's running session totals for the development world's Claude threads: each session's
 * overall cost and its split by model (Claude Code hands small work to Haiku).
 */
function claudeSessions(now: number): Record<string, UsageSessionTotal[]> {
  const sessions: [thread: string, model: string, main: number, haiku: number, agoHours: number][] =
    [
      ["thread-dedupe", "claude-opus-4-6", 4.61, 0.21, 1],
      ["thread-retry-budget", "claude-opus-4-6", 2.94, 0.12, 5],
      ["thread-resumable-streams", "claude-opus-4-6", 6.08, 0.33, 26],
      ["thread-checkout", "claude-opus-4-6", 1.37, 0.05, 49],
      ["thread-refund-tax", "claude-sonnet-4-6", 1.12, 0.06, 3],
      ["thread-haptics", "claude-sonnet-4-6", 0.74, 0.03, 30],
      ["thread-cold-start", "claude-sonnet-4-6", 0.081, 0, 2],
    ];
  return Object.fromEntries(
    sessions.map(([thread, model, main, haiku, agoHours]) => {
      const at = Math.max(0, now - agoHours * hour);
      const counterKey = `claude:${thread.replace("thread-", "session-")}:initial`;
      const snapshot = (scope: UsageSessionTotal["scope"], name: string, costUsd: number) => {
        const input = Math.round(costUsd * 180_000);
        return {
          counterKey,
          scope,
          model: name,
          at,
          inputTokens: input,
          outputTokens: Math.round(input * 0.06),
          cachedInputTokens: Math.round(input * 0.8),
          cacheWriteTokens: Math.round(input * 0.1),
          cacheWrite1hTokens: 0,
          costUsd,
        };
      };
      const snapshots = [
        snapshot("provider_session", "", Math.round((main + haiku) * 1e4) / 1e4),
        snapshot("model_session", model, main),
      ];
      if (haiku) snapshots.push(snapshot("model_session", "claude-haiku-4-5", haiku));
      return [thread, snapshots];
    }),
  );
}

const dayMs = 86_400_000;

/** Deterministic weekday-heavy wave, so the chart looks like a working fortnight. */
function factor(dayIndex: number, sourceIndex: number): number {
  const weekday = new Date(dayIndex * dayMs).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 0.25 : 1;
  const wave = 0.65 + 0.35 * Math.abs(Math.sin(dayIndex * 1.7 + sourceIndex * 2.3));
  return weekend * wave;
}

function totals(input: number, source: UsageSource): UsageTotals {
  const output = Math.round(input * 0.25);
  const usd = (perMillion: number) => ((input + output) / 1_000_000) * perMillion;
  const api = source.apiUsdPerMillion === null ? null : usd(source.apiUsdPerMillion);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: Math.round(input * 0.55),
    reasoningTokens: Math.round(output * 0.4),
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    providerReportedUsd: source.reportedUsdPerMillion ? usd(source.reportedUsdPerMillion) : 0,
    estimatedUsd: source.billing === "api" ? (api ?? 0) : 0,
    equivalentApiUsd: api,
    overflow: false,
    unpricedTokens: api === null ? input + output : 0,
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
    // Like the daemon: a group with any unpriced usage has no API estimate.
    equivalentApiUsd:
      a.equivalentApiUsd === null || b.equivalentApiUsd === null
        ? null
        : a.equivalentApiUsd + b.equivalentApiUsd,
    overflow: a.overflow || b.overflow,
    unpricedTokens: a.unpricedTokens + b.unpricedTokens,
    subscriptionTokens: a.subscriptionTokens + b.subscriptionTokens,
    unknownBillingTokens: a.unknownBillingTokens + b.unknownBillingTokens,
  };
}

/**
 * The usage service over a fixed set of accounts and models (`sources`) and Claude's session
 * totals per thread (`sessions`). Tests replace either to stage what the daemon reports.
 */
export class FakeUsage {
  sources: UsageSource[];
  sessions: Record<string, UsageSessionTotal[]>;
  /** The zone the daemon counts days in, named in every reply. */
  timezone = "UTC";
  constructor(now: number) {
    this.sources = [...sources];
    this.sessions = claudeSessions(now);
  }

  /**
   * Answers `usage.series` / `usage.summary`. Groups and filters by day, thread, provider,
   * account and model; other dimensions group as null. Like the daemon, a series is always per day.
   */
  report(asked: UsageQuery, kind: "summary" | "series"): UsageResult {
    const query =
      kind === "series" && !asked.groupBy.includes("day")
        ? { ...asked, groupBy: ["day" as const, ...asked.groupBy] }
        : asked;
    const from = Math.floor(Date.parse(query.from) / dayMs);
    const to = Math.floor(Date.parse(query.to) / dayMs);
    const groups = new Map<string, UsageRow>();
    for (let dayIndex = from; dayIndex <= to; dayIndex++) {
      const date = new Date(dayIndex * dayMs).toISOString().slice(0, 10);
      this.sources.forEach((source, index) => {
        const values: Partial<Record<UsageDimension, string | null>> = {
          day: date,
          thread: source.threads[(dayIndex + index) % source.threads.length] ?? null,
          provider: source.provider,
          account: source.account,
          model: source.model,
        };
        const filtered = Object.entries(query.filters).some(
          ([dimension, allowed]) =>
            allowed && !allowed.includes(values[dimension as UsageDimension] ?? ""),
        );
        if (filtered) return;
        const input = source.steady
          ? source.daily
          : Math.round(source.daily * factor(dayIndex, index));
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
        ? row.totals.providerReportedUsd || row.totals.estimatedUsd
        : row.totals.inputTokens + row.totals.outputTokens;
    if (!query.groupBy.includes("day")) rows.sort((a, b) => value(b) - value(a));
    return {
      cursor: 0,
      omittedEvents: 0,
      timezone: this.timezone,
      priceVersion: "fake-2026-10",
      rows: rows.slice(0, query.limit),
      truncated: rows.length > query.limit,
    };
  }

  /** Answers `usage.session_totals`: the thread's snapshots, newest first. */
  sessionTotals(query: UsageSessionTotalsQuery): UsageSessionTotal[] {
    return (this.sessions[query.thread] ?? [])
      .toSorted((a, b) => b.at - a.at)
      .slice(0, query.limit);
  }
}
