import type { UsageTotals } from "@ace/protocol";

/**
 * What some usage cost, kept in its two kinds: what the providers reported they charged, and what
 * the same tokens would cost at API list prices. The two are never added together.
 */
export interface UsageCost {
  /** Input plus output tokens. */
  tokens: number;
  /** Dollars the providers reported: per-step costs plus whole provider sessions. */
  reported: number;
  /** The per-step part of `reported` (OpenCode reports a cost with each step). */
  perStep: number;
  /** The session part of `reported` (Claude reports a running total per session). */
  sessions: SessionCost;
  /** At API prices, over the usage that has prices; null when none of it has. */
  apiPrice: number | null;
  /** Tokens with no API price, so missing from `apiPrice`. */
  unpricedTokens: number;
}

export interface SessionCost {
  /** Provider sessions with a reported total. */
  count: number;
  usd: number;
}

/** One inclusive snapshot from `usage.session_totals`. */
export interface SessionTotalSnapshot {
  counterKey: string;
  scope: "provider_session" | "model_session";
  model: string;
  costUsd: number;
}

const none: SessionCost = { count: 0, usd: 0 };

/**
 * Dollars reported per provider session. A session's total already includes its per-model
 * totals, so each session counts once: its provider total, or the sum of its per-model totals
 * when the provider reported no overall one. The same session seen from two threads (a fork that
 * shares it) counts once, at its latest (largest) total.
 */
export function sessionCost(snapshots: Iterable<SessionTotalSnapshot>): SessionCost {
  const totals = new Map<string, number>();
  const models = new Map<string, Map<string, number>>();
  for (const snapshot of snapshots) {
    if (snapshot.scope === "provider_session") {
      totals.set(
        snapshot.counterKey,
        Math.max(totals.get(snapshot.counterKey) ?? 0, snapshot.costUsd),
      );
      continue;
    }
    const byModel = models.get(snapshot.counterKey) ?? new Map<string, number>();
    byModel.set(snapshot.model, Math.max(byModel.get(snapshot.model) ?? 0, snapshot.costUsd));
    models.set(snapshot.counterKey, byModel);
  }
  for (const [key, byModel] of models)
    if (!totals.has(key))
      totals.set(
        key,
        [...byModel.values()].reduce((sum, usd) => sum + usd, 0),
      );
  let usd = 0;
  for (const value of totals.values()) usd += value;
  return { count: totals.size, usd };
}

/**
 * The cost of additive usage rows (`usage.series` / `usage.summary`) and the provider sessions
 * active over the same span. The daemon keeps session totals out of the rows, so adding the
 * per-step costs and the session totals counts nothing twice.
 */
export function usageCost(
  rows: readonly { totals: UsageTotals }[],
  sessions: SessionCost = none,
): UsageCost {
  let tokens = 0;
  let perStep = 0;
  let apiPrice: number | null = null;
  let unpricedTokens = 0;
  for (const { totals } of rows) {
    const used = totals.inputTokens + totals.outputTokens;
    tokens += used;
    perStep += totals.providerReportedUsd;
    // A group with any unpriced tokens has no API estimate at all; count those tokens as unpriced.
    if (totals.equivalentApiUsd === null) unpricedTokens += used;
    else {
      apiPrice = (apiPrice ?? 0) + totals.equivalentApiUsd;
      unpricedTokens += totals.unpricedTokens;
    }
  }
  if (apiPrice === null && tokens === 0) apiPrice = 0;
  return {
    tokens,
    reported: perStep + sessions.usd,
    perStep,
    sessions,
    apiPrice,
    unpricedTokens,
  };
}

/** 9_214_000 → "9.2M", 840_000 → "840K". */
export function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

/** Dollars, with cents shown down to a hundredth of a cent: "$412", "$4.82", "$0.0017". */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}

/** An API-price estimate, or "Unavailable" when the usage has no prices (never "$0.00"). */
export function formatApiPrice(value: number | null): string {
  return value === null ? "Unavailable" : formatUsd(value);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day `days` before `now` as YYYY-MM-DD, as usage queries name days. */
export function usageDay(now: number, days = 0): string {
  const date = new Date(now - days * 86_400_000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
