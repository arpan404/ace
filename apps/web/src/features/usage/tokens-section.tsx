import {
  formatTokens,
  tokenTable,
  usagePercent,
  type TokenRow,
  type TokenRowKind,
  type UsageReport,
} from "@ace/ui-core";
import { SectionHeading, Stat } from "./usage-parts.tsx";

/** Token types in the chart's palette: cache in its blues, output in ink, reasoning violet. */
const swatch: Record<TokenRowKind, string> = {
  cacheRead: "bg-(--token-cache-read)",
  cacheWrite: "bg-(--token-cache-write)",
  input: "bg-muted-foreground",
  output: "bg-foreground",
  reasoning: "bg-(--token-reasoning)",
};

/** "cache writes", "reasoning": a row named inside a sentence. */
const inSentence: Record<TokenRowKind, string> = {
  cacheRead: "cache reads",
  cacheWrite: "cache writes",
  input: "uncached input",
  output: "output",
  reasoning: "reasoning",
};
const either = new Intl.ListFormat("en", { type: "disjunction" });

function detail(row: TokenRow): string | undefined {
  if (row.detail === "billedAsOutput") return "Billed as output";
  if (row.detail)
    return `5-min ${formatTokens(row.detail.cacheWrite5m)} · 1-hour ${formatTokens(row.detail.cacheWrite1h)}`;
  return undefined;
}

const numeric = "w-28 py-1.5 text-right tabular-nums";

/**
 * Tokens: what kind of tokens the period was, as a thin share bar and a compact table that adds
 * up to the whole (reasoning is a part of output, shown apart from it, never on top). Types with
 * none fold into one quiet line. Then what the cache saved, how much ran on subscriptions, what
 * API-key accounts were billed, and the basis of every cost on the page.
 */
export function TokensSection(props: {
  report: UsageReport;
  period: string;
  money(value: number): string;
  /** "Prices from LiteLLM, updated Nov 1, 2026". */
  prices: string | undefined;
}) {
  const table = tokenTable(props.report);
  const used = table.rows.filter((row) => row.tokens > 0);
  const unused = table.rows.filter((row) => row.tokens <= 0);
  return (
    <section aria-labelledby="usage-tokens">
      <SectionHeading id="usage-tokens" title="Tokens">
        <span>
          {props.period} · {formatTokens(table.tokens)} tokens · {usagePercent(table.cacheHitRate)}{" "}
          of input from cache
        </span>
      </SectionHeading>
      <div aria-hidden className="flex h-1.5 max-w-160 gap-0.5 overflow-hidden rounded-full">
        {used.map((row) => (
          <span
            key={row.kind}
            style={{ flexGrow: row.tokenShare }}
            className={`basis-0 ${swatch[row.kind]}`}
          />
        ))}
      </div>
      <table className="mt-3 w-full max-w-160 text-ui">
        <caption className="sr-only">Tokens and cost by type</caption>
        <thead>
          <tr className="text-xs text-subtle-foreground">
            <th scope="col" className="py-1.5 text-left font-normal">
              Type
            </th>
            <th scope="col" className={`${numeric} font-normal`}>
              Tokens
            </th>
            <th scope="col" className={`${numeric} font-normal`}>
              Cost
            </th>
            <th scope="col" className={`${numeric} font-normal`}>
              Share of cost
            </th>
          </tr>
        </thead>
        <tbody>
          {used.map((row) => (
            <tr key={row.kind} data-kind={row.kind} className="align-top">
              <th scope="row" className="py-1.5 text-left font-normal">
                <span className="flex items-baseline gap-2">
                  <span aria-hidden className={`size-2 shrink-0 rounded-xs ${swatch[row.kind]}`} />
                  <span className="min-w-0">
                    {row.label}
                    {detail(row) && (
                      <span className="block text-xs text-subtle-foreground tabular-nums">
                        {detail(row)}
                      </span>
                    )}
                  </span>
                </span>
              </th>
              <td className={numeric}>{formatTokens(row.tokens)}</td>
              <td className={numeric}>{props.money(row.usd)}</td>
              <td className={`${numeric} text-muted-foreground`}>{usagePercent(row.costShare)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {unused.length > 0 && (
        <p className="mt-1 text-xs text-subtle-foreground">
          No {either.format(unused.map((row) => inSentence[row.kind]))} in this period.
        </p>
      )}
      <dl className="mt-6 flex flex-wrap gap-x-12 gap-y-3">
        <Stat label="Cache saved" value={props.money(table.cacheSavingsUsd)} tone="good" />
        <Stat label="Cache hit rate" value={usagePercent(table.cacheHitRate)} />
        <Stat
          label="On subscriptions"
          value={usagePercent(table.subscriptionShare)}
          unit="of tokens"
        />
        <Stat label="Billed by API" value={props.money(table.apiBilledUsd)} />
      </dl>
      <p className="mt-3 max-w-160 text-xs text-subtle-foreground">
        Costs are what the same tokens would cost on each provider's API price list. Subscription
        use isn't charged per token; "Billed by API" is spend on API-key accounts at those prices.
        {table.unpricedTokens > 0 &&
          ` ${formatTokens(table.unpricedTokens)} tokens from unpriced models aren't in the costs.`}
      </p>
      {props.prices && <p className="mt-1 text-xs text-subtle-foreground">{props.prices}</p>}
    </section>
  );
}
