import { formatApiPrice, formatTokens, usageCost, usageDay } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";
import { useAccountViews } from "./accounts-source.ts";
import { DailyBars } from "./daily-bars.tsx";
import { useProviderUsage, type UsageRange } from "./usage-source.ts";

const days = 14;

/**
 * One provider's last two weeks on its Settings page: tokens per day, the total, what those
 * tokens would cost at API prices (an estimate, said so), and each account's share. Plan limits
 * sit with each account; the full report is in Usage & accounts.
 */
export function ProviderUsage(props: { provider: string }) {
  const now = useNow();
  const zone = useUsageTimeZone();
  const range: UsageRange = {
    from: usageDay(now, zone.timeZone, days - 1),
    to: usageDay(now, zone.timeZone),
    timeZone: zone.timeZone,
    ready: zone.ready,
  };
  const usage = useProviderUsage(range, props.provider);
  const accounts = useAccountViews();
  if (usage.daily.isError)
    return <p className="px-4 py-3 text-muted-foreground">Usage couldn't be read.</p>;
  const rows = usage.daily.data?.rows ?? [];
  const cost = usageCost(rows);
  const labels = new Map(accounts.data?.map((account) => [account.id, account.label]));
  const shares = (usage.accounts.data?.rows ?? []).filter((row) => row.dimensions.account);
  if (usage.daily.data && cost.tokens === 0)
    return <p className="px-4 py-3.5 text-muted-foreground">No usage in the last {days} days.</p>;
  return (
    <div className="flex flex-col gap-4 p-4">
      <dl className="grid grid-cols-2 gap-4">
        <div>
          <dt className="text-sm text-muted-foreground">Tokens, last {days} days</dt>
          <dd className="mt-0.5 text-xl font-medium tabular-nums">
            {usage.daily.data ? formatTokens(cost.tokens) : "–"}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">At API prices</dt>
          <dd className="mt-0.5 text-xl font-medium tabular-nums">
            {usage.daily.data && cost.apiPrice !== null ? formatApiPrice(cost.apiPrice) : "–"}
          </dd>
          <dd className="text-xs text-subtle-foreground">
            {usage.daily.data && cost.apiPrice === null
              ? "No API prices for these models."
              : "Estimate. What these tokens would cost on an API key."}
          </dd>
        </div>
      </dl>
      {rows.length > 0 && <DailyBars rows={rows} className="mt-0" barsClassName="h-20" />}
      {shares.length > 1 && (
        <ul aria-label="Usage by account" className="flex flex-col gap-1 text-sm">
          {shares.map((row) => {
            const share = usageCost([row]);
            const id = row.dimensions.account ?? "";
            return (
              <li key={id} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{labels.get(id) ?? id}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatTokens(share.tokens)} · {formatApiPrice(share.apiPrice)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Link
        to="/more/accounts"
        className="self-start rounded-xs text-sm text-muted-foreground focus-ring hover:text-foreground"
      >
        Full usage and scheduling ›
      </Link>
    </div>
  );
}
