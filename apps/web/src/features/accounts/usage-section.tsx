import type { UsageTotals } from "@ace/protocol";
import { useMemo, useState, type ReactNode } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { DataTable, type DataColumns } from "@/components/data-table.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  catalogModelNames,
  formatApiPrice,
  formatTokens,
  formatUsd,
  providerNames,
  usageCost,
  usageDay,
} from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useNow } from "@/lib/time.ts";
import { useUsageTimeZone } from "@/lib/usage-timezone.ts";
import { ProviderKind } from "@ace/protocol";
import {
  useDailyUsage,
  useModelUsage,
  useReportedCosts,
  type ReportedCosts,
  type UsageRange,
  useAccountUsage,
} from "./usage-source.ts";
import { useAccountViews } from "./accounts-source.ts";
import { DailyBars } from "./daily-bars.tsx";
import { Headroom } from "./headroom.tsx";

type Range = "7" | "14" | "30";
const ranges = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
] as const satisfies readonly { value: Range; label: string }[];

const tokens = (totals: UsageTotals) => totals.inputTokens + totals.outputTokens;

interface ModelRow {
  /** The model, or the account when grouped by account. */
  model: string;
  provider: string;
  providerId: string | null;
  tokens: string;
  /** What the provider reported per step, or where its cost is reported instead. */
  reported: string;
  apiPrice: string;
}
type Group = "model" | "account";
const groups = [
  { value: "model", label: "By model" },
  { value: "account", label: "By account" },
] as const satisfies readonly { value: Group; label: string }[];
const columnsFor = (group: Group): DataColumns<ModelRow> => [
  { accessorKey: "model", header: group === "model" ? "Model" : "Account" },
  {
    accessorKey: "provider",
    header: "Provider",
    cell: ({ row }) => {
      const provider = ProviderKind.safeParse(row.original.providerId);
      return (
        <span className="inline-flex items-center gap-2">
          {provider.success && (
            <ProviderIcon provider={provider.data} label={row.original.provider} size={14} />
          )}
          <span aria-hidden={provider.success}>{row.original.provider}</span>
        </span>
      );
    },
  },
  { accessorKey: "tokens", header: "Tokens" },
  { accessorKey: "reported", header: "Reported" },
  { accessorKey: "apiPrice", header: "At API prices" },
];
const columns = { model: columnsFor("model"), account: columnsFor("account") };

const providerLabel = (id: string | null | undefined) => {
  const parsed = ProviderKind.safeParse(id);
  return parsed.success ? providerNames[parsed.data] : (id ?? "Other");
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Everything providers reported, and each provider's share (per step and per session). */
function reportedSummary(costs: ReportedCosts) {
  const providers = new Map<string | null, { usd: number; sessions: number }>();
  for (const [provider, usd] of costs.perStep)
    if (usd > 0) providers.set(provider, { usd, sessions: 0 });
  for (const [provider, cost] of costs.sessions.byProvider) {
    if (cost.usd <= 0) continue;
    const entry = providers.get(provider) ?? { usd: 0, sessions: 0 };
    providers.set(provider, { usd: entry.usd + cost.usd, sessions: entry.sessions + cost.count });
  }
  let total = 0;
  for (const entry of providers.values()) total += entry.usd;
  const shares = [...providers]
    .toSorted((a, b) => b[1].usd - a[1].usd)
    .map(([provider, entry]) => {
      const name = provider === null ? "Other sessions" : providerLabel(provider);
      const over = entry.sessions ? ` over ${plural(entry.sessions, "session")}` : "";
      return `${name} ${formatUsd(entry.usd)}${over}`;
    });
  const { unread, unlisted, failed, clipped } = costs.gaps;
  const gaps = [
    (unread > 0 || unlisted) &&
      `leaves out sessions of ${unlisted ? "more than " : ""}${plural(unread, "quieter thread")}`,
    failed > 0 && `${plural(failed, "thread")} couldn't be read`,
    clipped > 0 && `${plural(clipped, "thread")} had more sessions than one read returns`,
    costs.truncated && "leaves out some providers",
  ].filter((gap) => typeof gap === "string");
  const notes = [shares.length ? shares.join(" · ") : "No provider reported a cost"];
  if (gaps.length) notes.push(`Partial: ${gaps.join("; ")}`);
  return { total, note: notes.join(". ") };
}

/** Tokens per day and per model over a range, what providers reported and API-price estimates. */
export function UsageSection() {
  const now = useNow();
  const zone = useUsageTimeZone();
  const [range, setRange] = useState<Range>("14");
  const span: UsageRange = {
    from: usageDay(now, zone.timeZone, Number(range) - 1),
    to: usageDay(now, zone.timeZone),
    timeZone: zone.timeZone,
    ready: zone.ready,
  };
  const [group, setGroup] = useState<Group>("model");
  const daily = useDailyUsage(span);
  const byModel = useModelUsage(span);
  const byAccount = useAccountUsage(span, group === "account");
  const accounts = useAccountViews();
  const catalog = useModelCatalog();
  const modelName = useMemo(() => catalogModelNames(catalog ?? []), [catalog]);
  const reported = useReportedCosts(span);
  const sessionCosts = reported.data?.sessions.byProvider;
  const grouped = group === "model" ? byModel : byAccount;
  const models = useMemo<ModelRow[]>(() => {
    const labels = new Map(accounts.data?.map((account) => [account.id, account.label]));
    return (grouped.data?.rows ?? []).map((row) => {
      const cost = usageCost([row]);
      const provider = row.dimensions.provider ?? null;
      const account = row.dimensions.account;
      return {
        model:
          group === "model"
            ? modelName(provider ?? "", row.dimensions.model)
            : account
              ? (labels.get(account) ?? "Other account")
              : "Not attributed",
        provider: providerLabel(provider),
        providerId: provider,
        tokens: formatTokens(cost.tokens),
        reported:
          cost.perStep > 0
            ? formatUsd(cost.perStep)
            : sessionCosts?.get(provider)?.count
              ? "Per session"
              : "–",
        apiPrice: formatApiPrice(cost.apiPrice),
      };
    });
  }, [grouped.data, group, accounts.data, sessionCosts, modelName]);
  const rows = daily.data?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + tokens(row.totals), 0);
  const subscription = rows.reduce((sum, row) => sum + row.totals.subscriptionTokens, 0);
  const api = byModel.data && usageCost(byModel.data.rows);
  const paid = reported.data && reportedSummary(reported.data);
  const groupName = group === "model" ? "model" : "account";
  return (
    <section aria-labelledby="usage-title" className="mt-10">
      <div className="flex items-center gap-4">
        <h2 id="usage-title" className="min-w-0 flex-1 text-md font-medium">
          Usage
        </h2>
        <SegmentedControl
          label="Range"
          size="sm"
          value={range}
          options={ranges}
          onValueChange={(value) => setRange(value)}
        />
      </div>
      {accounts.data && <Headroom accounts={accounts.data} />}
      {daily.isError ? (
        <p role="alert" className="mt-3 text-ui text-muted-foreground">
          {daily.error.message}
        </p>
      ) : (
        <>
          <dl className="mt-4 flex flex-col">
            <Stat label="Tokens" value={daily.data && formatTokens(total)} />
            <Stat
              label="Reported cost"
              value={reported.isError ? "Unavailable" : paid && formatUsd(paid.total)}
              note={reported.isError ? "Reported costs couldn't be read" : paid?.note}
            />
            <Stat
              label="At API prices"
              value={byModel.isError ? "Unavailable" : api && formatApiPrice(api.apiPrice)}
              note={
                byModel.isError
                  ? "Usage by model couldn't be read"
                  : [
                      api?.apiPrice === null
                        ? "No API prices for these models"
                        : api?.unpricedTokens
                          ? `Leaves out ${formatTokens(api.unpricedTokens)} tokens without a price`
                          : undefined,
                      byModel.data?.truncated && "Covers the 1,000 busiest models",
                    ]
                      .filter((note) => typeof note === "string")
                      .join(". ")
              }
            />
            <Stat
              label="On subscriptions"
              value={daily.data && (total ? `${Math.round((subscription / total) * 100)}%` : "–")}
            />
          </dl>
          <DailyBars rows={rows} />
          {reported.isError && (
            <ReadFailed className="mt-5" retry={() => void reported.refetch()}>
              Reported costs couldn't be read.
            </ReadFailed>
          )}
          <div className="mt-5">
            <SegmentedControl
              label="Group usage"
              size="sm"
              value={group}
              options={groups}
              onValueChange={(value) => setGroup(value)}
            />
            <div className="mt-3">
              {grouped.isError ? (
                <ReadFailed retry={() => void grouped.refetch()}>
                  Usage by {groupName} couldn't be read.
                </ReadFailed>
              ) : (
                <>
                  <DataTable
                    caption={`Usage by ${groupName}`}
                    columns={columns[group]}
                    data={models}
                    empty={grouped.data ? "No usage." : "Loading usage…"}
                  />
                  {grouped.data?.truncated && (
                    <p className="mt-2 text-xs text-subtle-foreground">
                      Shows the {models.length.toLocaleString()} busiest {groupName}s; the rest are
                      left out.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** A read that failed, said where its figures would be, with a way to read it again. */
function ReadFailed(props: { retry: () => void; children: ReactNode; className?: string }) {
  return (
    <div
      role="alert"
      className={cn("flex items-center gap-3 text-ui text-muted-foreground", props.className)}
    >
      <span className="min-w-0 flex-1">{props.children}</span>
      <Button size="sm" onClick={props.retry}>
        Try again
      </Button>
    </div>
  );
}

/** One figure; a skeleton until its value has loaded. */
function Stat(props: { label: string; value: string | undefined; note?: string | undefined }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5">
      <dt className="text-xs font-medium text-subtle-foreground">{props.label}</dt>
      <dd className="text-ui font-medium tabular-nums">
        {props.value ?? <Skeleton className="my-1.5 h-4 w-16" />}
      </dd>
      {props.value !== undefined && props.note && (
        <dd className="w-full text-xs text-subtle-foreground">{props.note}</dd>
      )}
    </div>
  );
}
