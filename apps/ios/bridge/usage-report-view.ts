import {
  formatShare,
  formatTokens,
  formatUsd,
  growthBasis,
  pluralCount,
  usageAxis,
  usageGrowth,
  usageHue,
  type UsageGrowth,
  type UsageHue,
  type UsageReport,
} from "@ace/ui-core";

/*
 * The Usage screen's Cost and Tokens views, worded for Swift: the web Usage page's figures
 * (`usageReport` in `@ace/ui-core`) with growth against the period before. Every number is
 * already compact text ("19.3B", "$412", "+12%"); Swift only draws.
 */

export type UsageMetric = "tokens" | "cost";

export interface UsageProviderLine {
  id: string;
  name: string;
  /** The provider's hue; null draws in the theme's ink (`ink`) or its muted ink. */
  hue: UsageHue | null;
  ink: boolean;
  figure: string;
  detail: string;
  sessions: string;
  growth: UsageGrowth;
}

export interface UsageChartDay {
  day: string;
  /** "Oct 3" under the chart; "Fri, Oct 3" when the day is picked. */
  label: string;
  title: string;
  /** One value per chart series, in the series' order. */
  values: number[];
  texts: string[];
}

export interface UsageChart {
  title: string;
  /** The y axis: round steps from zero to just past the peak, with compact labels. */
  axis: { value: number; label: string }[];
  top: number;
  /** The chart's name for assistive tech: its peak day. */
  summary: string;
  series: { id: string; name: string; hue: UsageHue | null; ink: boolean }[];
  days: UsageChartDay[];
}

export interface UsageMetricView {
  total: string;
  growth: UsageGrowth;
  basis: string;
  sessions: string;
  /** Said once under the total on Cost: what the money means. */
  note: string | null;
  providers: UsageProviderLine[];
  chart: UsageChart;
  totals: { label: string; value: string }[];
  types: { title: string; parts: { key: string; label: string; value: number; text: string }[] };
  /** Any tokens in the range: false draws the empty state instead of zeroes. */
  hasUsage: boolean;
}

export interface UsageNames {
  provider(id: string): string;
}

const typeOrder = ["input", "cacheRead", "cacheWrite", "output"] as const;
const typeNames = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
};
const estimateNote =
  "API estimate: what these tokens would cost at each model's list API price. Subscriptions bill differently; models ace has no price for are left out.";
const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const dayTitle = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);

const look = (provider: string | null) => ({
  hue: provider ? usageHue(provider) : null,
  ink: provider === null || provider === "codex",
});

/** One metric's view of `report`, with growth against `previous` (the period before). */
export function usageMetricView(
  report: UsageReport,
  previous: UsageReport,
  days: number,
  metric: UsageMetric,
  names: UsageNames,
): UsageMetricView {
  const money = metric === "cost";
  const format = money ? formatUsd : formatTokens;
  const value = (entry: { tokens: number; usd: number }) => (money ? entry.usd : entry.tokens);
  const providers = report.providers.toSorted((a, b) =>
    money ? b.usd - a.usd || b.tokens - a.tokens : b.tokens - a.tokens,
  );
  const before = new Map(previous.providers.map((entry) => [entry.provider, entry]));
  const series = providers.map((entry) => ({
    id: entry.provider,
    name: names.provider(entry.provider),
    ...look(entry.provider),
  }));
  const chartDays = report.days.map((day) => {
    const values = providers.map((entry) =>
      value(day.byProvider.get(entry.provider) ?? { tokens: 0, usd: 0 }),
    );
    return {
      day: day.day,
      label: dayLabel.format(at(day.day)),
      title: dayTitle.format(at(day.day)),
      values,
      texts: values.map(format),
    };
  });
  const max = Math.max(0, ...chartDays.flatMap((day) => day.values));
  const axis = usageAxis(max, money ? "usd" : "tokens");
  const peak = report.days.reduce<(typeof report.days)[number] | undefined>(
    (best, day) => (best && value(best) >= value(day) ? best : day),
    undefined,
  );
  const title = money ? "Daily cost" : "Daily processed tokens";
  const totals = [
    { label: "Processed tokens", value: formatTokens(report.tokens) },
    { label: "Cached input", value: formatTokens(report.cachedInput) },
    { label: "Uncached input", value: formatTokens(report.uncachedInput) },
    { label: "Output", value: formatTokens(report.tokenTypes.output) },
    { label: "Cache savings", value: formatUsd(report.cacheSavingsUsd) },
  ];
  if (money && report.reportedUsd > 0)
    totals.push({ label: "Reported by providers", value: formatUsd(report.reportedUsd) });
  if (report.unpricedTokens > 0)
    totals.push({ label: "Unpriced tokens", value: formatTokens(report.unpricedTokens) });
  const typeValues = money ? report.costTypes : report.tokenTypes;
  const sessionWord = `${pluralCount(report.sessions, "session")}${report.sessionsCapped ? "+" : ""}`;
  return {
    total: format(value(report)),
    growth: usageGrowth(value(report), value(previous)),
    basis: growthBasis(days),
    sessions: sessionWord,
    note: money ? estimateNote : null,
    providers: providers.map((entry) => {
      const unpricedOnly = entry.usd === 0 && entry.unpricedTokens > 0;
      const prior = before.get(entry.provider);
      const { hue, ink } = look(entry.provider);
      return {
        id: entry.provider,
        name: names.provider(entry.provider),
        hue,
        ink,
        figure: money
          ? unpricedOnly
            ? "Unpriced"
            : formatUsd(entry.usd)
          : formatTokens(entry.tokens),
        detail: money
          ? `${formatShare(entry.usd, report.usd)} of cost · ${formatTokens(entry.tokens)} tokens`
          : `${formatShare(entry.tokens, report.tokens)} of tokens · ${unpricedOnly ? "Unpriced" : formatUsd(entry.usd)}`,
        sessions: pluralCount(entry.sessions, "session"),
        growth: usageGrowth(value(entry), prior ? value(prior) : 0),
      };
    }),
    chart: {
      title,
      axis: axis.ticks,
      top: axis.top,
      summary:
        peak && max > 0
          ? `${title}, highest ${format(value(peak))} on ${dayLabel.format(at(peak.day))}`
          : `${title}, none in this range`,
      series,
      days: chartDays,
    },
    totals,
    types: {
      title: money ? "Cost by type" : "Tokens by type",
      parts: typeOrder.map((key) => {
        const amount = Math.max(0, typeValues[key]);
        return { key, label: typeNames[key], value: amount, text: format(amount) };
      }),
    },
    hasUsage: report.tokens > 0,
  };
}
