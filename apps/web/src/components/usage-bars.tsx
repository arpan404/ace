import type { HeadroomBar, HeadroomTone } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { railPlaceClass } from "./rail-place.ts";

const toneFill: Record<HeadroomTone, string> = {
  ok: "fill-current",
  low: "fill-status-needs-you",
  out: "fill-status-failed",
};

const barWidth = 3;
const barGap = 2;
const barTop = 2;
const barHeight = 16;

/**
 * The rail's Usage glyph: a tiny bar chart in a 20px box, one 3px bar per provider (2px apart,
 * round ends), as tall as its pooled session left, over a quiet track in the glyph's own ink so it
 * weighs what the other rail glyphs weigh. Amber when low; a spent provider keeps a short red stub
 * so its bar never vanishes. With nothing read, three empty tracks show.
 */
export function UsageBars(props: { bars: readonly HeadroomBar[]; size?: number }) {
  const size = props.size ?? 20;
  const bars = props.bars;
  const count = bars.length || 3;
  const start = (20 - (count * barWidth + (count - 1) * barGap)) / 2;
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 20 20" data-slot="usage-bars">
      {Array.from({ length: count }, (_, index) => {
        const bar = bars[index];
        const x = start + index * (barWidth + barGap);
        const fill = bar
          ? Math.max(bar.tone === "out" ? 2 : barWidth, (barHeight * Math.min(100, bar.left)) / 100)
          : 0;
        return (
          <g key={bar?.key ?? index} data-tone={bar?.tone}>
            <rect
              x={x}
              y={barTop}
              width={barWidth}
              height={barHeight}
              rx={barWidth / 2}
              className="fill-current opacity-25"
            />
            {bar && (
              <rect
                x={x}
                y={barTop + barHeight - fill}
                width={barWidth}
                height={fill}
                rx={Math.min(barWidth / 2, fill / 2)}
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
