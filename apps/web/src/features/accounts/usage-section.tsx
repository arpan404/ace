import type { UsageRow, UsageTotals } from "@ace/protocol";
import { useMemo, useState } from "react";
import { DataTable, type DataColumns } from "@/components/data-table.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  formatApiPrice,
  formatTokens,
  formatUsd,
  providerNames,
  usageCost,
  usageDay,
  type SessionCost,
} from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import { ProviderKind } from "@ace/protocol";
import {
  useDailyUsage,
  useModelUsage,
  useSessionCosts,
  type SessionCosts,
} from "./usage-source.ts";

type Range = "7" | "14" | "30";
const ranges = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
] as const satisfies readonly { value: Range; label: string }[];

const tokens = (totals: UsageTotals) => totals.inputTokens + totals.outputTokens;

interface ModelRow {
  model: string;
  provider: string;
  tokens: string;
  /** What the provider reported per step, or where its cost is reported instead. */
  reported: string;
  apiPrice: string;
}
const columns: DataColumns<ModelRow> = [
  { accessorKey: "model", header: "Model" },
  { accessorKey: "provider", header: "Provider" },
  { accessorKey: "tokens", header: "Tokens" },
  { accessorKey: "reported", header: "Reported" },
  { accessorKey: "apiPrice", header: "At API prices" },
];

const providerLabel = (id: string | null | undefined) => {
  const parsed = ProviderKind.safeParse(id);
  return parsed.success ? providerNames[parsed.data] : (id ?? "Unknown provider");
};

const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const noSessions: SessionCost = { count: 0, usd: 0 };

function allSessions(costs: SessionCosts | undefined): SessionCost {
  let count = 0;
  let usd = 0;
  for (const cost of costs?.byProvider.values() ?? []) {
    count += cost.count;
    usd += cost.usd;
  }
  return count ? { count, usd } : noSessions;
}

/** Each provider's reported dollars, per step and per session, largest first. */
function reportedByProvider(rows: readonly UsageRow[], sessions: SessionCosts | undefined) {
  const providers = new Map<string | null, { usd: number; sessions: number }>();
  for (const row of rows) {
    if (row.totals.providerReportedUsd <= 0) continue;
    const provider = row.dimensions.provider ?? null;
    const entry = providers.get(provider) ?? { usd: 0, sessions: 0 };
    entry.usd += row.totals.providerReportedUsd;
    providers.set(provider, entry);
  }
  for (const [provider, cost] of sessions?.byProvider ?? []) {
    if (cost.usd <= 0) continue;
    const entry = providers.get(provider) ?? { usd: 0, sessions: 0 };
    entry.usd += cost.usd;
    entry.sessions += cost.count;
    providers.set(provider, entry);
  }
  return [...providers]
    .toSorted((a, b) => b[1].usd - a[1].usd)
    .map(([provider, entry]) => {
      const over = entry.sessions
        ? ` over ${entry.sessions} session${entry.sessions === 1 ? "" : "s"}`
        : "";
      return `${providerLabel(provider)} ${formatUsd(entry.usd)}${over}`;
    });
}

/** Tokens per day and per model over a range, what providers reported and API-price estimates. */
export function UsageSection() {
  const now = useNow();
  const [range, setRange] = useState<Range>("14");
  const span = { from: usageDay(now, Number(range) - 1), to: usageDay(now) };
  const daily = useDailyUsage(span);
  const byModel = useModelUsage(span);
  const sessions = useSessionCosts(span);
  const sessionCosts = sessions.data?.byProvider;
  const models = useMemo<ModelRow[]>(
    () =>
      (byModel.data?.rows ?? []).map((row) => {
        const cost = usageCost([row]);
        const provider = row.dimensions.provider ?? null;
        return {
          model: row.dimensions.model ?? "Not reported",
          provider: providerLabel(provider),
          tokens: formatTokens(cost.tokens),
          reported:
            cost.perStep > 0
              ? formatUsd(cost.perStep)
              : sessionCosts?.get(provider)?.count
                ? "Per session"
                : "–",
          apiPrice: formatApiPrice(cost.apiPrice),
        };
      }),
    [byModel.data, sessionCosts],
  );
  const rows = daily.data?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + tokens(row.totals), 0);
  const subscription = rows.reduce((sum, row) => sum + row.totals.subscriptionTokens, 0);
  const sessionsSettled = sessions.data !== undefined || sessions.isError;
  const cost = byModel.data && usageCost(byModel.data.rows, allSessions(sessions.data));
  const reported = byModel.data ? reportedByProvider(byModel.data.rows, sessions.data) : [];
  const reportedNotes = [
    reported.length ? reported.join(" · ") : "No provider reported a cost",
    sessions.isError && "Session totals unavailable",
    sessions.data?.failed && "Some session totals couldn't be read",
    sessions.data?.skipped && "Sessions of the 50 busiest threads",
  ].filter((note) => typeof note === "string");
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
      {daily.isError ? (
        <p role="alert" className="mt-3 text-ui text-muted-foreground">
          {daily.error.message}
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3.5 md:grid-cols-4">
            <Stat label="Tokens" value={daily.data && formatTokens(total)} />
            <Stat
              label="Reported cost"
              value={cost && sessionsSettled ? formatUsd(cost.reported) : undefined}
              note={reportedNotes.join(". ")}
            />
            <Stat
              label="At API prices"
              value={cost && formatApiPrice(cost.apiPrice)}
              note={
                cost?.apiPrice === null
                  ? "No API prices for these models"
                  : cost?.unpricedTokens
                    ? `Leaves out ${formatTokens(cost.unpricedTokens)} tokens without a price`
                    : undefined
              }
            />
            <Stat
              label="On subscriptions"
              value={daily.data && (total ? `${Math.round((subscription / total) * 100)}%` : "–")}
            />
          </dl>
          <DailyBars rows={rows} />
          <div className="mt-5">
            <DataTable caption="Usage by model" columns={columns} data={models} empty="No usage." />
          </div>
        </>
      )}
    </section>
  );
}

/** One figure; a skeleton until its value has loaded. */
function Stat(props: { label: string; value: string | undefined; note?: string | undefined }) {
  return (
    <div className="rounded-lg px-4 py-3 shadow-[inset_0_0_0_1px_var(--border)]">
      <dt className="text-xs font-medium text-subtle-foreground">{props.label}</dt>
      <dd className="mt-1 text-xl font-semibold tracking-title tabular-nums">
        {props.value ?? <Skeleton className="my-1.5 h-4 w-16" />}
      </dd>
      {props.value !== undefined && props.note && (
        <dd className="mt-1 text-xs text-subtle-foreground">{props.note}</dd>
      )}
    </div>
  );
}

/** One ink bar per day; hovering or focusing a bar names its day and value. */
function DailyBars(props: { rows: readonly UsageRow[] }) {
  const [active, setActive] = useState<number>();
  const values = props.rows.map((row) => tokens(row.totals));
  const max = Math.max(1, ...values);
  const shown = active === undefined ? undefined : props.rows[active];
  return (
    <figure className="mt-4 rounded-lg px-4 pt-3 pb-4 shadow-[inset_0_0_0_1px_var(--border)]">
      <figcaption className="flex h-5 items-baseline justify-between text-xs text-subtle-foreground">
        <span>Tokens per day</span>
        {shown && (
          <span aria-live="polite" className="text-foreground tabular-nums">
            {dayLabel.format(Date.parse(shown.dimensions.day ?? ""))} ·{" "}
            {formatTokens(tokens(shown.totals))}
          </span>
        )}
      </figcaption>
      <ol aria-label="Tokens per day" className="mt-2 flex h-36 items-end gap-0.5">
        {props.rows.map((row, index) => {
          const day = row.dimensions.day ?? "";
          const value = values[index] ?? 0;
          return (
            <li
              key={day}
              tabIndex={0}
              aria-label={`${dayLabel.format(Date.parse(day))}: ${formatTokens(value)} tokens`}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(undefined)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(undefined)}
              className="group flex h-full min-w-0 flex-1 items-end outline-none"
            >
              <span
                style={{ height: `${Math.max(2, (value / max) * 100)}%` }}
                className="block w-full rounded-t-[4px] bg-[color-mix(in_oklab,var(--foreground)_55%,transparent)] transition-colors duration-(--dur-1) group-hover:bg-foreground group-focus-visible:bg-foreground"
              />
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
