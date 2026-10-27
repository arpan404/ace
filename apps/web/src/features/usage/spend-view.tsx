import { InfoIcon } from "@phosphor-icons/react";
import { ProviderKind } from "@ace/protocol";
import {
  formatShare,
  formatTokens,
  formatUsd,
  usageGrowth,
  type ProviderUsage,
  type UsageGrowth,
  type TokenTypes,
  type UsageReport,
} from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { Breakdown } from "./breakdown.tsx";
import { DailyChart } from "./daily-chart.tsx";

type Metric = "tokens" | "cost";

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
const typeNames: TokenTypes<string> = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
};
const typeOrder = ["input", "cacheRead", "cacheWrite", "output"] as const;
const estimateNote =
  "API estimate: what these tokens would cost at each model's list API price. Subscriptions bill differently; models ace has no price for are left out.";

/**
 * Tokens or money over the range: the total with growth against the days before, each provider,
 * each day, each type, each model.
 */
export function SpendView(props: {
  report: UsageReport;
  /** The same number of days just before the range; undefined while it reads. */
  previous: UsageReport | undefined;
  /** What growth compares with: "vs previous 30 days". */
  basis: string;
  metric: Metric;
  providerName(id: string): string;
  modelName(provider: string, model: string): string;
}) {
  const { report, metric } = props;
  const money = metric === "cost";
  const providers = report.providers.toSorted((a, b) =>
    money ? b.usd - a.usd || b.tokens - a.tokens : b.tokens - a.tokens,
  );
  const sessions = `${plural(report.sessions, "session")}${report.sessionsCapped ? "+" : ""}`;
  const value = (entry: { tokens: number; usd: number }) => (money ? entry.usd : entry.tokens);
  const growth = props.previous && usageGrowth(value(report), value(props.previous));
  const before = new Map(props.previous?.providers.map((entry) => [entry.provider, entry]));
  return (
    <div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className="text-4xl leading-tight font-medium tabular-nums">
            {money ? formatUsd(report.usd) : formatTokens(report.tokens)}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            {growth && growth.direction !== "none" && (
              <>
                <span data-testid="usage-growth">
                  <span className="font-medium text-foreground tabular-nums">{growth.label}</span>{" "}
                  {props.basis}
                </span>
                <span aria-hidden>·</span>
              </>
            )}
            {sessions}
            {money && (
              <>
                <span aria-hidden>·</span>
                <Tip label={estimateNote}>
                  <span
                    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard
                    tabIndex={0}
                    className="inline-flex items-center gap-1 rounded-xs focus-ring"
                  >
                    API estimate
                    <InfoIcon size={12} aria-label="About the API estimate" />
                  </span>
                </Tip>
              </>
            )}
          </p>
          <ul aria-label="By provider" className="mt-5 flex flex-col gap-3">
            {providers.map((provider) => (
              <ProviderLine
                key={provider.provider}
                provider={provider}
                name={props.providerName(provider.provider)}
                report={report}
                money={money}
                growth={
                  props.previous
                    ? usageGrowth(value(provider), value(before.get(provider.provider) ?? nothing))
                    : undefined
                }
              />
            ))}
          </ul>
        </div>
        <DailyChart
          title={money ? "Daily cost" : "Daily processed tokens"}
          days={report.days}
          providers={providers.map((provider) => ({
            id: provider.provider,
            name: props.providerName(provider.provider),
          }))}
          value={(entry) => (money ? entry.usd : entry.tokens)}
          format={money ? formatUsd : formatTokens}
        />
      </div>
      <section aria-labelledby="usage-totals" className="mt-10">
        <h2 id="usage-totals" className="mb-2 text-xs font-medium text-muted-foreground">
          Totals
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
          <Stat label="Processed tokens" value={formatTokens(report.tokens)} />
          <Stat label="Cached input" value={formatTokens(report.cachedInput)} />
          <Stat label="Uncached input" value={formatTokens(report.uncachedInput)} />
          <Stat label="Output" value={formatTokens(report.tokenTypes.output)} />
          <Stat label="Cache savings" value={formatUsd(report.cacheSavingsUsd)} />
          {money && report.reportedUsd > 0 && (
            <Stat label="Reported by providers" value={formatUsd(report.reportedUsd)} />
          )}
          {report.unpricedTokens > 0 && (
            <Stat label="Unpriced tokens" value={formatTokens(report.unpricedTokens)} />
          )}
        </dl>
      </section>
      <TypeBar
        title={money ? "Cost by type" : "Tokens by type"}
        values={money ? report.costTypes : report.tokenTypes}
        format={money ? formatUsd : formatTokens}
      />
      <Breakdown report={report} metric={metric} modelName={props.modelName} />
    </div>
  );
}

const nothing = { tokens: 0, usd: 0 };

function ProviderLine(props: {
  provider: ProviderUsage;
  name: string;
  report: UsageReport;
  money: boolean;
  growth: UsageGrowth | undefined;
}) {
  const { provider, report, money } = props;
  const kind = ProviderKind.safeParse(provider.provider);
  const unpriced = provider.usd === 0 && provider.unpricedTokens > 0;
  const figure = money
    ? unpriced
      ? "Unpriced"
      : formatUsd(provider.usd)
    : formatTokens(provider.tokens);
  const detail = money
    ? `${formatShare(provider.usd, report.usd)} of cost · ${formatTokens(provider.tokens)} tokens`
    : `${formatShare(provider.tokens, report.tokens)} of tokens · ${
        unpriced ? "Unpriced" : formatUsd(provider.usd)
      }`;
  return (
    <li data-provider={provider.provider} aria-label={props.name} className="flex flex-col">
      <span className="flex items-center gap-2 text-ui">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-(--provider)" />
        {kind.success && <ProviderIcon provider={kind.data} size={14} decorative />}
        <span className="min-w-0 truncate">{props.name}</span>
        <span className="shrink-0 text-xs text-subtle-foreground">
          {plural(provider.sessions, "session")}
        </span>
        <span className="ml-auto pl-3 font-medium tabular-nums">{figure}</span>
      </span>
      <span className="flex pl-4 text-xs text-subtle-foreground">
        <span className="min-w-0 truncate">{detail}</span>
        {props.growth && props.growth.direction !== "none" && (
          <span className="ml-auto pl-3 tabular-nums" aria-label={`${props.growth.label} growth`}>
            {props.growth.label}
          </span>
        )}
      </span>
    </li>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle-foreground">{props.label}</dt>
      <dd className="text-md font-medium tabular-nums">{props.value}</dd>
    </div>
  );
}

function TypeBar(props: {
  title: string;
  values: TokenTypes<number>;
  format(value: number): string;
}) {
  const total = typeOrder.reduce((sum, type) => sum + Math.max(0, props.values[type]), 0);
  const tones = [
    "bg-muted-foreground/45",
    "bg-muted-foreground/25",
    "bg-muted-foreground/65",
    "bg-foreground",
  ];
  return (
    <section aria-labelledby="usage-types" className="mt-10">
      <h2 id="usage-types" className="mb-2 text-xs font-medium text-muted-foreground">
        {props.title}
      </h2>
      <div aria-hidden className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-secondary">
        {total > 0 &&
          typeOrder.map((type, index) => (
            <span
              key={type}
              style={{ flexGrow: Math.max(0, props.values[type]) / total }}
              className={`basis-0 ${tones[index] ?? ""}`}
            />
          ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {typeOrder.map((type, index) => (
          <li key={type} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-xs ${tones[index]}`} />
            <span className="text-muted-foreground">{typeNames[type]}</span>
            <span className="tabular-nums">{props.format(Math.max(0, props.values[type]))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
