import { formatTokens } from "@ace/ui-core";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import type { ActivityCell, ProfileStats } from "@ace/ui-core";

const longDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** One data blue (`--activity`), stronger for busier days; an empty day is a faint square. */
const levelClass: Record<ActivityCell["level"], string> = {
  0: "bg-foreground/[0.07]",
  1: "bg-[color-mix(in_oklab,var(--activity)_30%,transparent)]",
  2: "bg-[color-mix(in_oklab,var(--activity)_52%,transparent)]",
  3: "bg-[color-mix(in_oklab,var(--activity)_76%,transparent)]",
  4: "bg-(--activity)",
};

/**
 * A year of work as a grid: one column per week, Sunday at the top, each day shaded by how many
 * tokens its agents spent. Hovering a day names it and its total.
 */
export function ActivityGrid(props: { stats: ProfileStats }) {
  const { weeks, months } = props.stats;
  const [hover, setHover] = useState<{ week: number; day: number }>();
  const cell = hover && weeks[hover.week]?.[hover.day];
  const leftHalf = hover ? hover.week < weeks.length / 2 : true;
  return (
    <div className="relative" onMouseLeave={() => setHover(undefined)}>
      <div
        role="img"
        aria-label={`${formatTokens(props.stats.total)} tokens over the last year, on ${props.stats.activeDays} days`}
        className="grid grid-flow-col grid-rows-7 gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
      >
        {weeks.map((week, weekIndex) =>
          week.map((day, dayIndex) => (
            <span
              key={day.day}
              onMouseEnter={() => setHover({ week: weekIndex, day: dayIndex })}
              className={cn(
                "aspect-square rounded-xs",
                day.outside ? "invisible" : levelClass[day.level],
              )}
            />
          )),
        )}
      </div>
      <div aria-hidden className="relative mt-2 h-4 text-xs text-subtle-foreground">
        {months.map((month) => (
          <span
            key={`${month.label}-${month.week}`}
            className="absolute"
            style={{ left: `${(month.week / weeks.length) * 100}%` }}
          >
            {month.label}
          </span>
        ))}
      </div>
      {cell && !cell.outside && hover && (
        <div
          role="tooltip"
          className="ace-floating-solid pointer-events-none absolute z-10 rounded-popup px-2.5 py-1.5 text-xs whitespace-nowrap tabular-nums"
          style={{
            left: `${((hover.week + (leftHalf ? 1 : 0)) / weeks.length) * 100}%`,
            top: `${(hover.day / 7) * 100 * 0.82}%`,
            transform: leftHalf ? "translate(6px, -100%)" : "translate(calc(-100% - 6px), -100%)",
          }}
        >
          <p className="font-medium">{longDay.format(Date.parse(`${cell.day}T00:00:00Z`))}</p>
          <p className="text-muted-foreground">
            {cell.tokens > 0 ? `${formatTokens(cell.tokens)} tokens` : "No work"}
          </p>
        </div>
      )}
    </div>
  );
}
