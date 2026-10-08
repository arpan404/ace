import type { UsageRow, UsageTotals } from "@ace/protocol";
import { formatTokens } from "@ace/ui-core";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";

const tokens = (totals: UsageTotals) => totals.inputTokens + totals.outputTokens;

const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** One ink bar per day; hovering or focusing a bar names its day and value. */
export function DailyBars(props: {
  rows: readonly UsageRow[];
  className?: string;
  /** The bars' height; 9rem unless given. */
  barsClassName?: string;
}) {
  const [active, setActive] = useState<number>();
  const values = props.rows.map((row) => tokens(row.totals));
  const max = Math.max(1, ...values);
  const shown = active === undefined ? undefined : props.rows[active];
  return (
    <figure className={cn("mt-4 py-3", props.className)}>
      <figcaption className="flex h-5 items-baseline justify-between text-xs text-subtle-foreground">
        <span>Tokens per day</span>
        {shown && (
          <span aria-live="polite" className="text-foreground tabular-nums">
            {dayLabel.format(Date.parse(shown.dimensions.day ?? ""))} ·{" "}
            {formatTokens(tokens(shown.totals))}
          </span>
        )}
      </figcaption>
      <ol
        aria-label="Tokens per day"
        className={cn("mt-2 flex items-end gap-0.5", props.barsClassName ?? "h-36")}
      >
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
                className="block w-full rounded-t-xs bg-foreground/55 transition-colors duration-(--dur-1) group-hover:bg-foreground group-focus-visible:bg-foreground"
              />
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
