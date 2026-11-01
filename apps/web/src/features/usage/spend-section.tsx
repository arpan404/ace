import { formatTokens, growthSentence, type UsageReport } from "@ace/ui-core";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { SectionHeading, Stat } from "./usage-parts.tsx";
import { StackedChart } from "./stacked-chart.tsx";

export type Metric = "cost" | "tokens";
const metrics = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
] as const satisfies readonly { value: Metric; label: string }[];

/**
 * Spend: the period's total with its change against the period before in words, its daily
 * average and its tokens; then a day-by-day chart stacked by provider, whose legend gives each
 * provider's total. Money is the API estimate, at the page's one money format.
 */
export function SpendSection(props: {
  report: UsageReport;
  previous: UsageReport | undefined;
  /** "Last 30 days", "Today". */
  period: string;
  /** Days in the period, for "the previous 30 days". */
  days: number;
  metric: Metric;
  onMetric(metric: Metric): void;
  money(value: number): string;
  providerName(id: string): string;
  /** Narrow the page to one provider. */
  onProvider(id: string): void;
}) {
  const { report, metric } = props;
  const cost = metric === "cost";
  const value = (entry: { tokens: number; usd: number }) => (cost ? entry.usd : entry.tokens);
  const format = cost ? props.money : formatTokens;
  const change = props.previous && growthSentence(value(report), value(props.previous), props.days);
  const providers = report.providers.toSorted((a, b) => value(b) - value(a));
  return (
    <section aria-labelledby="usage-spend">
      <SectionHeading id="usage-spend" title="Spend">
        <span className="hidden sm:inline">
          {cost ? "Estimated API-equivalent cost" : "Processed tokens"}
        </span>
        <SegmentedControl
          label="Show"
          size="sm"
          value={metric}
          options={metrics}
          onValueChange={props.onMetric}
        />
      </SectionHeading>
      <dl className="flex flex-wrap gap-x-12 gap-y-3">
        <Stat
          label={props.period}
          value={format(value(report))}
          note={change}
          testId="usage-total"
        />
        <Stat label="Per day" value={format(value(report) / Math.max(1, props.days))} />
        <Stat label="Tokens" value={formatTokens(report.tokens)} />
      </dl>
      <StackedChart
        title={cost ? "Daily cost by provider" : "Daily tokens by provider"}
        unit={cost ? "usd" : "tokens"}
        days={report.days}
        providers={providers.map((entry) => ({
          id: entry.provider,
          name: props.providerName(entry.provider),
        }))}
        value={value}
        format={format}
      />
      <ul
        aria-label="By provider"
        className="mt-3 ml-11 flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums"
      >
        {providers.map((entry) => (
          <li key={entry.provider} data-provider={entry.provider}>
            <button
              type="button"
              onClick={() => props.onProvider(entry.provider)}
              className="flex items-center gap-1.5 rounded-xs hover:underline focus-ring"
            >
              <span aria-hidden className="size-2 rounded-xs bg-(--provider)" />
              <span className="text-foreground">{props.providerName(entry.provider)}</span>{" "}
              <span className="text-muted-foreground">
                {cost && entry.usd === 0 && entry.unpricedTokens > 0
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
