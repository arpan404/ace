import type { UsageDimension, UsageRow } from "@ace/protocol";
import { usageGrowth, type UsageGrowth } from "./usage-growth.ts";
import { pricedUsd, usageTokens } from "./usage-report.ts";

/*
 * Spend as one ledger: rows grouped by one dimension, inside a scope the person drilled into
 * (Claude › Work › ace). Clicking a row narrows the scope to it and groups by the next level
 * down: provider, account, project, thread. Every row carries its days for a trend and the same
 * span before, for its change. Machines are the page's own dimension: each daemon is one.
 */

export type LedgerGroup =
  | "provider"
  | "account"
  | "workspace"
  | "thread"
  | "model"
  | "machine"
  | "automation"
  | "skill"
  | "role";

export const ledgerGroups: readonly { value: LedgerGroup; label: string }[] = [
  { value: "provider", label: "Provider" },
  { value: "account", label: "Account" },
  { value: "workspace", label: "Project" },
  { value: "thread", label: "Thread" },
  { value: "model", label: "Model" },
  { value: "machine", label: "Machine" },
  { value: "automation", label: "Automation" },
  { value: "skill", label: "Skill" },
  { value: "role", label: "Agent" },
];

/** Where a click on a row leads; undefined for a thread, which opens instead. */
const below: Record<LedgerGroup, LedgerGroup | undefined> = {
  provider: "account",
  account: "workspace",
  workspace: "thread",
  machine: "workspace",
  model: "thread",
  automation: "thread",
  skill: "thread",
  role: "thread",
  thread: undefined,
};

export function nextLedgerGroup(group: LedgerGroup): LedgerGroup | undefined {
  return below[group];
}

/** One step of the scope: a row the person clicked, named for the crumbs. */
export interface LedgerStep {
  group: LedgerGroup;
  key: string;
  label: string;
}

/** The scope as usage-query filters, and the machine it keeps to, if any. */
export function ledgerScope(steps: readonly LedgerStep[]): {
  filters: Partial<Record<UsageDimension, string[]>>;
  machine: string | undefined;
} {
  const filters: Partial<Record<UsageDimension, string[]>> = {};
  let machine: string | undefined;
  for (const step of steps) {
    if (step.group === "machine") machine = step.key;
    else filters[step.group] = [step.key];
  }
  return { filters, machine };
}

/** Groups already fixed by the scope have one row, so they aren't offered. */
export function openLedgerGroups(steps: readonly LedgerStep[]): LedgerGroup[] {
  const fixed = new Set(steps.map((step) => step.group));
  return ledgerGroups.map((group) => group.value).filter((group) => !fixed.has(group));
}

/** The group a fresh scope shows: the level under its last step, else providers. */
export function ledgerGroupFor(steps: readonly LedgerStep[]): LedgerGroup {
  const last = steps.at(-1);
  const next = last && nextLedgerGroup(last.group);
  return next && openLedgerGroups(steps).includes(next)
    ? next
    : (openLedgerGroups(steps)[0] ?? "thread");
}

export interface LedgerFigure {
  tokens: number;
  usd: number;
  /** Tokens from models ace has no price for. */
  unpricedTokens: number;
}

export interface LedgerLine extends LedgerFigure {
  key: string;
  /** One figure per day of the span, in order; empty when the days weren't read. */
  days: LedgerFigure[];
  previous: LedgerFigure;
}

const zero = (): LedgerFigure => ({ tokens: 0, usd: 0, unpricedTokens: 0 });
const add = (figure: LedgerFigure, row: UsageRow) => {
  figure.tokens += usageTokens(row.totals);
  figure.usd += pricedUsd(row.totals);
  figure.unpricedTokens += row.totals.unpricedTokens;
};

/** One machine's answer for a dimension: totals, the span before, and days for some keys. */
export interface LedgerRead {
  totals: readonly UsageRow[];
  previous: readonly UsageRow[];
  /** Rows grouped by day and the dimension; may cover only the top keys. */
  series: readonly UsageRow[];
}

/**
 * Sum every machine's rows for `dimension` by value, most cost first (tokens break ties and rank
 * unpriced use). Rows without a value (use from before it was recorded) are left out, as are
 * values with no tokens in the span.
 */
export function ledgerLines(
  reads: readonly LedgerRead[],
  dimension: UsageDimension,
  days: readonly string[],
): LedgerLine[] {
  return collect(
    reads.map((read) => ({ read, keyOf: (row: UsageRow) => row.dimensions[dimension] })),
    days,
  );
}

/** One line per machine, from its own totals, days and span before. */
export function machineLedgerLines(
  machines: readonly { key: string; read: LedgerRead }[],
  days: readonly string[],
): LedgerLine[] {
  return collect(
    machines.map(({ key, read }) => ({ read, keyOf: () => key })),
    days,
  );
}

function collect(
  entries: readonly { read: LedgerRead; keyOf(row: UsageRow): string | null | undefined }[],
  days: readonly string[],
): LedgerLine[] {
  const lines = new Map<string, LedgerLine>();
  const dayIndex = new Map(days.map((each, index) => [each, index]));
  const line = (key: string) => {
    let found = lines.get(key);
    if (!found) {
      found = { key, ...zero(), days: [], previous: zero() };
      lines.set(key, found);
    }
    return found;
  };
  for (const { read, keyOf } of entries) {
    for (const row of read.totals) {
      const key = keyOf(row);
      if (key) add(line(key), row);
    }
    for (const row of read.previous) {
      const key = keyOf(row);
      if (key) add(line(key).previous, row);
    }
  }
  for (const { read, keyOf } of entries)
    for (const row of read.series) {
      const key = keyOf(row);
      const date = row.dimensions.day;
      const index = date ? dayIndex.get(date) : undefined;
      const target = key ? lines.get(key) : undefined;
      if (!target || index === undefined) continue;
      if (!target.days.length) target.days = days.map(zero);
      const day = target.days[index];
      if (day) add(day, row);
    }
  return rankLedger([...lines.values()].filter((each) => each.tokens > 0));
}

export function rankLedger(lines: readonly LedgerLine[]): LedgerLine[] {
  return lines.toSorted((a, b) => b.usd - a.usd || b.tokens - a.tokens || (a.key < b.key ? -1 : 1));
}

/** Its change against the span before, in cost or tokens. */
export function ledgerChange(line: LedgerLine, metric: "cost" | "tokens"): UsageGrowth {
  return metric === "cost"
    ? usageGrowth(line.usd, line.previous.usd)
    : usageGrowth(line.tokens, line.previous.tokens);
}

/** Rows shown before "Show all". */
export const ledgerTop = 8;
