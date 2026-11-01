import {
  formatTokens,
  formatUsd,
  tokenTable,
  type TokenRow,
  type TokenRowKind,
  type UsageReport,
} from "@ace/ui-core";
import { SectionHeading, Stat } from "./usage-parts.tsx";

/** Token types as one ink family: cache in the cool tones, output in the foreground. */
const swatch: Record<TokenRowKind, string> = {
  cacheRead: "bg-(--token-cache-read)",
  cacheWrite: "bg-(--token-cache-write)",
  input: "bg-muted-foreground",
  output: "bg-foreground",
  reasoning: "bg-(--token-reasoning)",
};

const percent = (share: number) =>
  share <= 0 ? "0%" : share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;

function detail(row: TokenRow): string | undefined {
  if (row.detail === "billedAsOutput") return "Billed as output";
  if (row.detail)
    return `5-min ${formatTokens(row.detail.cacheWrite5m)} · 1-hour ${formatTokens(row.detail.cacheWrite1h)}`;
  return undefined;
}

/**
 * Tokens: what kind of tokens the period was, as a share bar and a table that adds up to the
 * whole (reasoning is a part of output and shown apart from it, never on top), then what the
 * cache saved, how much of it ran on subscriptions, what API-key accounts were billed, and the
 * basis of every cost on the page.
 */
export function TokensSection(props: { report: UsageReport; period: string }) {
  const table = tokenTable(props.report);
  const cached = percent(table.cacheHitRate);
  return (
    <section aria-labelledby="usage-tokens">
      <SectionHeading id="usage-tokens" title="Tokens">
        <span>
          {props.period} · {formatTokens(table.tokens)} tokens · {cached} of input from cache
        </span>
      </SectionHeading>
      <div aria-hidden className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {table.rows.map((row) =>
          row.tokens > 0 ? (
            <span
              key={row.kind}
              style={{ flexGrow: row.tokenShare }}
              className={`basis-0 ${swatch[row.kind]}`}
            />
          ) : null,
        )}
      </div>
      <table className="mt-3 w-full text-ui">
        <caption className="sr-only">Tokens and cost by type</caption>
        <thead>
          <tr className="text-xs text-subtle-foreground">
            <th scope="col" className="py-1.5 text-left font-normal">
              Type
            </th>
            <th scope="col" className="py-1.5 text-right font-normal">
              Tokens
            </th>
            <th scope="col" className="py-1.5 text-right font-normal">
              Cost
            </th>
            <th scope="col" className="py-1.5 text-right font-normal">
              Share of cost
            </th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.kind} data-kind={row.kind} className="border-t border-border">
              <th scope="row" className="py-2 text-left font-normal">
                <span className="flex items-baseline gap-2">
                  <span aria-hidden className={`size-2 shrink-0 rounded-xs ${swatch[row.kind]}`} />
                  <span>
                    {row.label}
                    {detail(row) && (
                      <span className="block text-xs text-subtle-foreground">{detail(row)}</span>
                    )}
                  </span>
                </span>
              </th>
              <td className="py-2 text-right align-top tabular-nums">{formatTokens(row.tokens)}</td>
              <td className="py-2 text-right align-top tabular-nums">{formatUsd(row.usd)}</td>
              <td className="py-2 text-right align-top text-muted-foreground tabular-nums">
                {percent(row.costShare)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-5 flex flex-wrap gap-x-10 gap-y-3">
        <Stat label="Cache saved" value={formatUsd(table.cacheSavingsUsd)} tone="good" />
        <Stat label="Cache hit rate" value={cached} />
        <Stat label="On subscriptions" value={percent(table.subscriptionShare)} note="of tokens" />
        <Stat label="Billed by API" value={formatUsd(table.apiBilledUsd)} />
      </dl>
      <p className="mt-3 text-xs text-subtle-foreground">
        Costs are what the same tokens would cost on each provider's API price list. Subscription
        use isn't charged per token; "Billed by API" is spend on API-key accounts at those prices.
        {table.unpricedTokens > 0 &&
          ` ${formatTokens(table.unpricedTokens)} tokens from unpriced models aren't in the costs.`}
      </p>
    </section>
  );
}
