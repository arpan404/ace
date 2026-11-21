import { cn } from "@/lib/cn.ts";
import { changeWords } from "./change-bars.tsx";
import { overviewTicks, type OverviewInput, type OverviewTick } from "./overview.ts";

/*
 * The overview ruler in the editor's vertical scrollbar: the whole file's changes, agents'
 * lines, find hits and the caret line, as ticks over the scrollbar's track. The ruler itself
 * lets the pointer through to the scrollbar; a press on a tick brings its line into view.
 */

const tickColour: Record<OverviewTick["kind"], string> = {
  added: "bg-status-done",
  modified: "bg-status-working",
  removed: "bg-status-failed",
  agent: "bg-status-waiting",
  hit: "bg-foreground/45",
  caret: "bg-foreground/70",
};

const tickWords = (tick: OverviewTick): string => {
  const at = `line ${tick.line + 1}`;
  switch (tick.kind) {
    case "agent":
      return `Agent change at ${at}`;
    case "hit":
      return `Match at ${at}`;
    case "caret":
      return `Cursor at ${at}`;
    default:
      return `${changeWords[tick.kind]}, ${at}`;
  }
};

export function OverviewRuler(props: OverviewInput & { onJump(line: number): void }) {
  "use no memo";
  const ticks = overviewTicks(props);
  if (ticks.length === 0) return null;
  return (
    <div
      aria-hidden
      data-overview-ruler
      className="pointer-events-none absolute top-0 right-0 z-[2] w-2.5"
      style={{ height: props.height }}
    >
      {ticks.map((tick) => (
        <span
          key={`${tick.lane}-${tick.top}`}
          data-overview-tick={tick.kind}
          title={tickWords(tick)}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onJump(tick.line);
          }}
          className={cn(
            "pointer-events-auto absolute cursor-pointer",
            tick.lane === "change" && "left-0.5 w-[3px]",
            tick.lane === "hit" && "right-0.5 w-[3px]",
            tick.lane === "caret" && "inset-x-0",
            tickColour[tick.kind],
          )}
          style={{ top: tick.top, height: tick.lane === "caret" ? 2 : tick.height }}
        />
      ))}
    </div>
  );
}
