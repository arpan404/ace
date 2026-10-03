import type { UsageRow, UsageTotals } from "@ace/protocol";
import { useMemo, useState } from "react";
import { DataTable, type DataColumns } from "@/components/data-table.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { providerName } from "@/components/ui/provider-mark.tsx";
import { useNow } from "@/lib/time.ts";
import { ProviderKind } from "@ace/protocol";
import { useUsage } from "./accounts-source.ts";
import { formatTokens, formatUsd, isoDay } from "./format.ts";

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
  tokens: number;
  cost: number;
}
const columns: DataColumns<ModelRow> = [
  { accessorKey: "model", header: "Model" },
  { accessorKey: "provider", header: "Provider" },
  { id: "tokens", header: "Tokens", accessorFn: (row) => formatTokens(row.tokens) },
  { id: "cost", header: "At API prices", accessorFn: (row) => formatUsd(row.cost) },
];

const providerLabel = (id: string | null | undefined) => {
  const parsed = ProviderKind.safeParse(id);
  return parsed.success ? providerName(parsed.data) : (id ?? "Unknown");
};

const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Tokens per day and per model over a range, from the usage service. */
export function UsageSection() {
  const now = useNow();
  const [range, setRange] = useState<Range>("14");
  const from = isoDay(now, Number(range) - 1);
  const to = isoDay(now);
  const daily = useUsage({ from, to, groupBy: ["day"] });
  const byModel = useUsage({ from, to, groupBy: ["model", "provider"] });
  const models = useMemo<ModelRow[]>(
    () =>
      (byModel.data?.rows ?? []).map((row) => ({
        model: row.dimensions.model ?? "Unknown",
        provider: providerLabel(row.dimensions.provider),
        tokens: tokens(row.totals),
        cost: row.totals.equivalentApiUsd ?? row.totals.estimatedUsd,
      })),
    [byModel.data],
  );
  const rows = daily.data?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + tokens(row.totals), 0);
  const cost = rows.reduce((sum, row) => sum + (row.totals.equivalentApiUsd ?? 0), 0);
  const subscription = rows.reduce((sum, row) => sum + row.totals.subscriptionTokens, 0);
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
          <dl className="mt-4 grid grid-cols-3 gap-3.5">
            <Stat label="Tokens" value={formatTokens(total)} />
            <Stat label="At API prices" value={formatUsd(cost)} />
            <Stat
              label="On subscriptions"
              value={total ? `${Math.round((subscription / total) * 100)}%` : "–"}
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

function Stat(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-4 py-3 shadow-[inset_0_0_0_1px_var(--border)]">
      <dt className="text-xs font-medium text-subtle-foreground">{props.label}</dt>
      <dd className="mt-1 text-xl font-semibold tracking-title tabular-nums">{props.value}</dd>
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
                className="block w-full rounded-t-[4px] bg-[color-mix(in_oklab,var(--foreground)_55%,transparent)] transition-colors duration-150 group-hover:bg-foreground group-focus-visible:bg-foreground"
              />
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
