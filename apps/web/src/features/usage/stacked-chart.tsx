import type { DayUsage } from "@ace/ui-core";
import { useState } from "react";

const dayLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const label = (day: string) => dayLabel.format(Date.parse(`${day}T00:00:00Z`));

/**
 * Each day as one bar, stacked by provider in the provider's hue, largest provider at the base.
 * Pointing at a day names its figures above the chart; a screen reader gets the peak day and the
 * per-provider totals in the legend beside it.
 */
export function StackedChart(props: {
  title: string;
  days: readonly DayUsage[];
  /** Providers in stacking order, bottom first. */
  providers: readonly { id: string; name: string }[];
  value(entry: { tokens: number; usd: number }): number;
  format(value: number): string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { days, providers } = props;
  const totals = days.map((day) =>
    providers.reduce(
      (sum, provider) =>
        sum + Math.max(0, props.value(day.byProvider.get(provider.id) ?? { tokens: 0, usd: 0 })),
      0,
    ),
  );
  const top = Math.max(0, ...totals) || 1;
  const peakIndex = totals.indexOf(Math.max(...totals));
  const peak = days[peakIndex];
  const hovered = hover === null ? undefined : days[hover];
  const today = days.length - 1;
  const middle = Math.floor(today / 2);
  return (
    <figure className="mt-4">
      <figcaption className="h-5 text-xs text-subtle-foreground tabular-nums">
        {hovered ? (
          <>
            <span className="text-foreground">{label(hovered.day)}</span>
            {" · "}
            {props.format(totals[hover ?? 0] ?? 0)}
            {providers.map((provider) => {
              const value = props.value(
                hovered.byProvider.get(provider.id) ?? { tokens: 0, usd: 0 },
              );
              return value > 0 ? ` · ${provider.name} ${props.format(value)}` : "";
            })}
          </>
        ) : (
          props.title
        )}
      </figcaption>
      <div
        role="img"
        aria-label={`${props.title}${peak && totals[peakIndex] ? `, highest on ${label(peak.day)} at ${props.format(totals[peakIndex] ?? 0)}` : ""}`}
        className="flex h-36 items-end gap-[3px] border-b border-border pt-2"
        onPointerLeave={() => setHover(null)}
      >
        {days.map((day, index) => (
          <div
            key={day.day}
            data-day={day.day}
            onPointerEnter={() => setHover(index)}
            className="flex h-full min-w-0 flex-1 flex-col-reverse gap-px"
          >
            {providers.map((provider) => {
              const value = props.value(day.byProvider.get(provider.id) ?? { tokens: 0, usd: 0 });
              if (value <= 0) return null;
              return (
                <span
                  key={provider.id}
                  data-provider={provider.id}
                  style={{ height: `${(value / top) * 100}%` }}
                  className={`block rounded-t-[2px] bg-(--provider) ${hover !== null && hover !== index ? "opacity-50" : ""}`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div aria-hidden className="mt-1.5 flex justify-between text-2xs text-subtle-foreground">
        <span>{days[0] ? label(days[0].day) : ""}</span>
        {today > 1 && <span>{days[middle] ? label(days[middle].day) : ""}</span>}
        <span>{today > 0 ? "Today" : ""}</span>
      </div>
    </figure>
  );
}
