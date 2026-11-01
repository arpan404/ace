import { usageAxis, type DayUsage } from "@ace/ui-core";
import { useState } from "react";

const dayLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const longDay = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const label = (day: string) => dayLabel.format(Date.parse(`${day}T00:00:00Z`));

const zero = { tokens: 0, usd: 0 };

/**
 * Each day as one bar stacked by provider (largest at the base), on a 160px plot with three faint
 * gridlines labelled on the left. Bars are wider than the gaps between them. Pointing at a day
 * shows its total and split in a tooltip; a screen reader gets the peak day in the chart's name.
 */
export function StackedChart(props: {
  title: string;
  unit: "usd" | "tokens";
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
      (sum, provider) => sum + Math.max(0, props.value(day.byProvider.get(provider.id) ?? zero)),
      0,
    ),
  );
  const peak = Math.max(0, ...totals);
  const axis = usageAxis(peak, props.unit, 3);
  const top = axis.top || 1;
  const peakIndex = totals.indexOf(peak);
  const peakDay = days[peakIndex];
  const hovered = hover === null ? undefined : days[hover];
  const last = days.length - 1;
  const middle = Math.floor(last / 2);
  // The tooltip sits beside the bar, flipped to the left in the right half of the chart.
  const tipLeft = hover !== null && hover > last / 2;
  return (
    <figure className="mt-5">
      <div className="relative flex h-40">
        <div
          aria-hidden
          className="relative w-11 shrink-0 text-2xs text-subtle-foreground tabular-nums"
        >
          {axis.ticks.slice(1).map((tick) => (
            <span
              key={tick.value}
              style={{ bottom: `${(tick.value / top) * 100}%` }}
              className="absolute right-2 translate-y-1/2"
            >
              {tick.label}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={`${props.title}${peakDay && peak ? `, highest on ${label(peakDay.day)} at ${props.format(peak)}` : ""}`}
          className="relative flex min-w-0 flex-1 items-end border-b border-border"
          onPointerLeave={() => setHover(null)}
        >
          {axis.ticks.slice(1).map((tick) => (
            <span
              key={tick.value}
              aria-hidden
              style={{ bottom: `${(tick.value / top) * 100}%` }}
              className="absolute inset-x-0 border-t border-border-soft"
            />
          ))}
          {days.map((day, index) => (
            <div
              key={day.day}
              data-day={day.day}
              onPointerEnter={() => setHover(index)}
              className="relative flex h-full min-w-0 flex-1 items-end justify-center"
            >
              <div
                className={`flex w-[64%] max-w-6 flex-col-reverse gap-px transition-opacity duration-(--motion-fast) ${hover !== null && hover !== index ? "opacity-45" : ""}`}
                style={{ height: `${((totals[index] ?? 0) / top) * 100}%` }}
              >
                {providers.map((provider) => {
                  const value = props.value(day.byProvider.get(provider.id) ?? zero);
                  if (value <= 0) return null;
                  return (
                    <span
                      key={provider.id}
                      data-provider={provider.id}
                      style={{ flexGrow: value }}
                      className="block min-h-px basis-0 bg-(--provider) last:rounded-t-xs"
                    />
                  );
                })}
              </div>
            </div>
          ))}
          {hovered && hover !== null && (
            <div
              role="tooltip"
              style={{
                left: `${((hover + (tipLeft ? 0 : 1)) / days.length) * 100}%`,
                transform: tipLeft ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
              }}
              className="ace-floating-solid pointer-events-none absolute top-0 z-10 w-52 rounded-popup px-3 py-2.5 text-xs tabular-nums"
            >
              <p className="flex justify-between font-semibold">
                <span>{longDay.format(Date.parse(`${hovered.day}T00:00:00Z`))}</span>
                <span>{props.format(totals[hover] ?? 0)}</span>
              </p>
              {providers.map((provider) => {
                const value = props.value(hovered.byProvider.get(provider.id) ?? zero);
                if (value <= 0) return null;
                return (
                  <p
                    key={provider.id}
                    data-provider={provider.id}
                    className="mt-1 flex items-center gap-2"
                  >
                    <span aria-hidden className="size-2 shrink-0 rounded-xs bg-(--provider)" />
                    <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                    <span className="text-muted-foreground">{props.format(value)}</span>
                  </p>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div
        aria-hidden
        className="mt-1.5 ml-11 flex justify-between text-2xs text-subtle-foreground tabular-nums"
      >
        <span>{days[0] ? label(days[0].day) : ""}</span>
        {last > 1 && <span>{days[middle] ? label(days[middle].day) : ""}</span>}
        <span>{last > 0 ? "Today" : ""}</span>
      </div>
    </figure>
  );
}
