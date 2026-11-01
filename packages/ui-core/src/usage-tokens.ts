import type { UsageReport } from "./usage-report.ts";

/*
 * The Usage page's Tokens table: every processed token in exactly one row, so the rows add up to
 * the total. Input includes cache reads and writes, and output includes reasoning (ADR 0040), so
 * each subset is taken out of its parent before it is shown on its own, never added again.
 */

export type TokenRowKind = "cacheRead" | "cacheWrite" | "input" | "output" | "reasoning";

export interface TokenRow {
  kind: TokenRowKind;
  label: string;
  /** "5-min 41M · 1-hour 8M", "Billed as output". */
  detail?: { cacheWrite5m: number; cacheWrite1h: number } | "billedAsOutput" | undefined;
  tokens: number;
  /** API estimate for these tokens; priced models only. */
  usd: number;
  /** Share of all tokens and of the priced cost, 0–1. */
  tokenShare: number;
  costShare: number;
}

export interface TokenTable {
  rows: TokenRow[];
  tokens: number;
  usd: number;
  /** Cache reads over all input. */
  cacheHitRate: number;
  cacheSavingsUsd: number;
  /** Tokens on subscription accounts over all tokens. */
  subscriptionShare: number;
  /** The estimate for API-key accounts' tokens. */
  apiBilledUsd: number;
  unpricedTokens: number;
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

export function tokenTable(report: UsageReport): TokenTable {
  const types = report.tokenTypes;
  const costs = report.costTypes;
  const write = Math.max(0, types.cacheWrite);
  const write1h = Math.min(write, Math.max(0, report.cacheWrite1hTokens));
  const output = Math.max(0, types.output);
  const reasoning = Math.min(output, Math.max(0, report.reasoningTokens));
  // Reasoning is priced as output: its share of output's cost is its share of output's tokens.
  const reasoningUsd = costs.output * ratio(reasoning, output);
  const parts: Omit<TokenRow, "tokenShare" | "costShare">[] = [
    { kind: "cacheRead", label: "Cache reads", tokens: types.cacheRead, usd: costs.cacheRead },
    {
      kind: "cacheWrite",
      label: "Cache writes",
      detail: { cacheWrite5m: write - write1h, cacheWrite1h: write1h },
      tokens: write,
      usd: costs.cacheWrite,
    },
    { kind: "input", label: "Uncached input", tokens: types.input, usd: costs.input },
    {
      kind: "output",
      label: "Output",
      tokens: output - reasoning,
      usd: costs.output - reasoningUsd,
    },
    {
      kind: "reasoning",
      label: "Reasoning",
      detail: "billedAsOutput",
      tokens: reasoning,
      usd: reasoningUsd,
    },
  ];
  const tokens = parts.reduce((sum, row) => sum + row.tokens, 0);
  const usd = parts.reduce((sum, row) => sum + row.usd, 0);
  return {
    rows: parts.map((row): TokenRow =>
      Object.assign(row, {
        tokenShare: ratio(row.tokens, tokens),
        costShare: ratio(row.usd, usd),
      }),
    ),
    tokens,
    usd,
    cacheHitRate: ratio(types.cacheRead, types.cacheRead + types.cacheWrite + types.input),
    cacheSavingsUsd: report.cacheSavingsUsd,
    subscriptionShare: ratio(report.subscriptionTokens, report.tokens),
    apiBilledUsd: report.apiBilledUsd,
    unpricedTokens: report.unpricedTokens,
  };
}
