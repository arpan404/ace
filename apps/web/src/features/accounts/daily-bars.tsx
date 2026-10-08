import type { UsageRow, UsageTotals } from "@ace/protocol";
import { formatTokens } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { ProgressBar } from "@/components/ui/progress-bar.tsx";

const tokens = (totals: UsageTotals) => totals.inputTokens + totals.outputTokens;
const dayLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Labelled daily totals with a thin meter relative to the busiest day. */
export function DailyBars(props: { rows: readonly UsageRow[]; className?: string }) {
  const max = Math.max(1, ...props.rows.map((row) => tokens(row.totals)));
  return (
    <figure className={cn("mt-4", props.className)}>
      <figcaption className="mb-2 text-xs text-muted-foreground">Tokens per day</figcaption>
      <ol aria-label="Tokens per day">
        {props.rows.map((row) => {
          const day = row.dimensions.day ?? "";
          const value = tokens(row.totals);
          const label = dayLabel.format(Date.parse(day));
          return (
            <li key={day} className="flex h-8 items-center gap-3 text-xs tabular-nums">
              <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
              <ProgressBar
                label={`${label} tokens`}
                value={(value / max) * 100}
                valueText={`${formatTokens(value)} tokens`}
                className="flex-1"
              />
              <span className="w-14 text-right">{formatTokens(value)}</span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
