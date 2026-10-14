import type { DayUsage } from "@ace/ui-core";
import { useRef, useState, type PointerEvent } from "react";
import { useElementSize } from "@/lib/element-size.ts";

const height = 168;
const pad = { top: 8, right: 8, bottom: 22, left: 44 };
const dayLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const label = (day: string) => dayLabel.format(Date.parse(`${day}T00:00:00Z`));

/**
 * A day-by-day line per provider, in the provider's hue. Pointing at the chart shows that day's
 * figures; a screen reader gets the peak day in the chart's name.
 */
export function DailyChart(props: {
  title: string;
  days: readonly DayUsage[];
  providers: readonly { id: string; name: string }[];
  value(entry: { tokens: number; usd: number }): number;
  format(value: number): string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = Math.max(240, useElementSize(box).width);
  const [hover, setHover] = useState<number | null>(null);
  const { days, providers } = props;
  const series = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    values: days.map((day) =>
      props.value(day.byProvider.get(provider.id) ?? { tokens: 0, usd: 0 }),
    ),
  }));
  const max = Math.max(0, ...series.flatMap((entry) => entry.values));
  const top = max > 0 ? max : 1;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const x = (index: number) =>
    pad.left + (days.length > 1 ? (index / (days.length - 1)) * plotWidth : plotWidth / 2);
  const y = (value: number) => pad.top + plotHeight - (value / top) * plotHeight;
  const peak = days.reduce<DayUsage | undefined>(
    (best, day) => (best && props.value(best) >= props.value(day) ? best : day),
    undefined,
  );
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!days.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const at = event.clientX - rect.left - pad.left;
    const step = days.length > 1 ? plotWidth / (days.length - 1) : plotWidth;
    setHover(Math.min(days.length - 1, Math.max(0, Math.round(at / step))));
  };
  const hovered = hover === null ? undefined : days[hover];
  const ticks = [0, 0.5, 1];
  const xTicks =
    days.length > 2
      ? [0, Math.floor((days.length - 1) / 2), days.length - 1]
      : days.map((_, index) => index);
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-xs font-medium text-muted-foreground">
        {props.title}
      </figcaption>
      <div ref={box} className="relative">
        <svg
          role="img"
          aria-label={
            peak && max > 0
              ? `${props.title}, highest ${props.format(props.value(peak))} on ${label(peak.day)}`
              : `${props.title}, none in this range`
          }
          width={width}
          height={height}
          className="block touch-none select-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(tick * top)}
                y2={y(tick * top)}
                className="stroke-border-soft"
              />
              <text
                x={pad.left - 6}
                y={y(tick * top)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-subtle-foreground text-2xs tabular-nums"
              >
                {props.format(tick * max)}
              </text>
            </g>
          ))}
          {xTicks.map((index) => {
            const day = days[index];
            return day ? (
              <text
                key={day.day}
                x={x(index)}
                y={height - 6}
                textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}
                className="fill-subtle-foreground text-2xs uppercase"
              >
                {label(day.day)}
              </text>
            ) : null;
          })}
          {series.map((entry) => (
            <g key={entry.id} data-provider={entry.id}>
              {days.length > 1 ? (
                <polyline
                  fill="none"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  className="stroke-(--provider)"
                  points={entry.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}
                />
              ) : (
                <circle
                  cx={x(0)}
                  cy={y(entry.values[0] ?? 0)}
                  r={3}
                  className="fill-(--provider)"
                />
              )}
            </g>
          ))}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad.top}
              y2={pad.top + plotHeight}
              className="stroke-border-strong"
            />
          )}
        </svg>
        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-1 min-w-36 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-glass"
            style={{
              left: Math.min(width - 152, Math.max(0, x(hover) + 10)),
            }}
          >
            <div className="mb-1 font-medium">{label(hovered.day)}</div>
            {series.map((entry) => (
              <div key={entry.id} data-provider={entry.id} className="flex items-center gap-2">
                <span aria-hidden className="size-2 rounded-full bg-(--provider)" />
                <span className="flex-1 text-muted-foreground">{entry.name}</span>
                <span className="tabular-nums">{props.format(entry.values[hover] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
