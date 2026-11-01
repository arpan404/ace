import type { HeadroomBar, HeadroomTone } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { railPlaceClass } from "./rail-place.ts";

const toneFill: Record<HeadroomTone, string> = {
  ok: "fill-foreground",
  low: "fill-status-needs-you",
  out: "fill-status-failed",
};

/**
 * The rail's Usage glyph: a tiny bar chart, one bar per provider, as tall as its pooled session
 * left. A spent provider keeps a short red stub so its bar never vanishes; with nothing read,
 * the tracks alone show, quietly.
 */
export function UsageBars(props: { bars: readonly HeadroomBar[]; size?: number }) {
  const size = props.size ?? 22;
  const bars = props.bars;
  const count = bars.length || 3;
  const width = 4;
  const gap = count > 3 ? 1.5 : 2.5;
  const start = (24 - (count * width + (count - 1) * gap)) / 2;
  const top = 4;
  const height = 16;
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" data-slot="usage-bars">
      {Array.from({ length: count }, (_, index) => {
        const bar = bars[index];
        const x = start + index * (width + gap);
        const fill = bar
          ? Math.max(bar.tone === "out" ? 2.5 : 1.5, (height * Math.min(100, bar.left)) / 100)
          : 0;
        return (
          <g key={bar?.key ?? index} data-tone={bar?.tone}>
            <rect
              x={x}
              y={top}
              width={width}
              height={height}
              rx={1.6}
              className={cn("fill-faint-foreground", !bar && "opacity-60")}
            />
            {bar && (
              <rect
                x={x}
                y={top + height - fill}
                width={width}
                height={fill}
                rx={1.6}
                className={toneFill[bar.tone]}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}


/** Usage in the rail before its live figures load: the empty bars, linking to the page. */
export function UsageLink(props: { current: boolean }) {
  return (
    <Link
      to="/usage"
      aria-label="Usage"
      aria-current={props.current ? "page" : undefined}
      className={railPlaceClass}
      data-slot="rail-usage"
    >
      <UsageBars bars={[]} />
    </Link>
  );
}
