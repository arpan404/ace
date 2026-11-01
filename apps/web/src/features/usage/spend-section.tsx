import { formatTokens, formatUsd, usageGrowth, type UsageReport } from "@ace/ui-core";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { SectionHeading, Stat } from "./usage-parts.tsx";
import { StackedChart } from "./stacked-chart.tsx";

export type Metric = "cost" | "tokens";
const metrics = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
] as const satisfies readonly { value: Metric; label: string }[];

/**
 * Spend: the period's total, its daily average, its change against the period before and its
 * tokens; then a day-by-day chart stacked by provider, whose legend gives each provider's total.
 * Money is the API estimate, what the tokens would cost at list prices.
 */
export function SpendSection(props: {
  report: UsageReport;
  previous: UsageReport | undefined;
  /** "Last 30 days", "Today". */
  period: string;
  /** "vs previous 30 days". */
  basis: string;
  metric: Metric;
  onMetric(metric: Metric): void;
  providerName(id: string): string;
  /** Narrow the page to one provider. */
  onProvider(id: string): void;
}) {
  const { report, metric } = props;
  const money = metric === "cost";
  const value = (entry: { tokens: number; usd: number }) => (money ? entry.usd : entry.tokens);
  const format = money ? formatUsd : formatTokens;
  const growth = props.previous && usageGrowth(value(report), value(props.previous));
  const days = Math.max(1, report.days.length);
  const providers = report.providers.toSorted((a, b) => value(b) - value(a));
  return (
    <section aria-labelledby="usage-spend">
      <SectionHeading id="usage-spend" title="Spend">
        <span className="hidden sm:inline">
          {money ? "Estimated API-equivalent cost" : "Processed tokens"}
        </span>
        <SegmentedControl
          label="Show"
          size="sm"
          value={metric}
          options={metrics}
          onValueChange={props.onMetric}
        />
      </SectionHeading>
      <dl className="mt-3.5 flex flex-wrap gap-x-10 gap-y-3">
        <Stat label={props.period} value={format(value(report))} />
        <Stat label="Per day" value={format(value(report) / days)} />
        {growth && growth.direction !== "none" && (
          <Stat label={props.basis} value={growth.label} testId="usage-growth" />
        )}
        <Stat label="Tokens" value={formatTokens(report.tokens)} />
      </dl>
      <StackedChart
        title={money ? "Daily cost by provider" : "Daily tokens by provider"}
        days={report.days}
        providers={providers.map((entry) => ({
          id: entry.provider,
          name: props.providerName(entry.provider),
        }))}
        value={value}
        format={format}
      />
      <ul aria-label="By provider" className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {providers.map((entry) => (
          <li key={entry.provider} data-provider={entry.provider}>
            <button
              type="button"
              onClick={() => props.onProvider(entry.provider)}
              className="flex items-center gap-1.5 rounded-xs text-muted-foreground hover:text-foreground focus-ring"
            >
              <span aria-hidden className="size-2 rounded-xs bg-(--provider)" />
              {props.providerName(entry.provider)}{" "}
              <span className="text-foreground tabular-nums">
                {money && entry.usd === 0 && entry.unpricedTokens > 0
                  ? "Unpriced"
                  : format(value(entry))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
