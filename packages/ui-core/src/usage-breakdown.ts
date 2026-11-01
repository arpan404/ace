import type { UsageDimension, UsageRow } from "@ace/protocol";
import { pricedUsd, usageTokens } from "./usage-report.ts";

/*
 * The Usage page's "Where it went" lists: usage by one dimension, summed across the machines
 * shown and ranked by API-estimate cost (tokens break ties, and rank unpriced usage). Clicking a
 * row filters the page to that value through the usage queries' own filters.
 */

/** The page's lists, in order. `machine` is the page's own: one figure per machine read. */
export type BreakdownKind =
  | "workspace"
  | "model"
  | "account"
  | "skill"
  | "automation"
  | "machine"
  | "role"
  | "thread";

export const breakdownKinds: readonly BreakdownKind[] = [
  "workspace",
  "model",
  "account",
  "skill",
  "automation",
  "machine",
  "role",
  "thread",
];

export const breakdownTitles: Record<BreakdownKind, string> = {
  workspace: "By project",
  model: "By model",
  account: "By account",
  skill: "By skill",
  automation: "By automation",
  machine: "By machine",
  role: "Main agents and subagents",
  thread: "By thread",
};

export const roleLabels: Record<string, string> = {
  main: "Main agents",
  subagent: "Subagents",
  delegated: "Delegated threads",
};

export interface BreakdownLine {
  /** The dimension's value; the filter a click applies. */
  key: string;
  tokens: number;
  usd: number;
  /** Tokens from models ace has no price for: all of them reads "Unpriced", never $0.00. */
  unpricedTokens?: number | undefined;
}

/** A line whose every token is from an unpriced model has no cost to show. */
export const unpricedLine = (line: BreakdownLine) =>
  line.tokens > 0 && (line.unpricedTokens ?? 0) >= line.tokens;

/** Rows shown before "Show all". */
export const breakdownTop = 5;

/**
 * Sum each machine's rows for `dimension` by value and rank them, most cost first. Rows without
 * a value (usage before the dimension was recorded, or a thread no automation started) and rows
 * with no tokens are left out.
 */
export function rankBreakdown(
  machines: readonly (readonly UsageRow[])[],
  dimension: UsageDimension,
): BreakdownLine[] {
  const lines = new Map<string, BreakdownLine>();
  for (const rows of machines)
    for (const row of rows) {
      const key = row.dimensions[dimension];
      const tokens = usageTokens(row.totals);
      if (!key || tokens <= 0) continue;
      const line = lines.get(key) ?? { key, tokens: 0, usd: 0, unpricedTokens: 0 };
      line.tokens += tokens;
      line.usd += pricedUsd(row.totals);
      line.unpricedTokens = (line.unpricedTokens ?? 0) + row.totals.unpricedTokens;
      lines.set(key, line);
    }
  return rankLines([...lines.values()]);
}

export function rankLines(lines: readonly BreakdownLine[]): BreakdownLine[] {
  return lines.toSorted((a, b) => b.usd - a.usd || b.tokens - a.tokens || (a.key < b.key ? -1 : 1));
}

/** A page filter a breakdown row sets: one dimension and value, named for the person. */
export interface UsageFilter {
  kind: BreakdownKind | "provider";
  key: string;
  label: string;
}

/** The usage-query filters for the page's filter; machines filter by which daemons are read. */
export function usageQueryFilters(
  filter: UsageFilter | undefined,
): Partial<Record<UsageDimension, string[]>> {
  if (!filter || filter.kind === "machine") return {};
  return { [filter.kind]: [filter.key] };
}
