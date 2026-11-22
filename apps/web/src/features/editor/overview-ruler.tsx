import { cn } from "@/lib/cn.ts";
import { changeWords } from "./change-bars.tsx";
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import {
  caretTick,
  laneTicks,
  markRuns,
  type OverviewInput,
  type OverviewTick,
} from "./overview.ts";

/*
 * The overview ruler in the editor's vertical scrollbar: the whole file's changes, agents'
 * lines, find hits and the caret line, as ticks over the scrollbar's track. The ruler itself
 * lets the pointer through to the scrollbar; a press on a tick brings its line into view.
 */

const tickColour: Record<OverviewTick["kind"], string> = {
  added: "bg-status-done",
  modified: "bg-status-working",
  removed: "bg-status-failed",
  agent: "bg-status-needs-you",
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

export function OverviewRuler(
  props: OverviewInput & {
    /** The row layout's revision: the change and hit ticks are placed again when it moves. */
    revision: number;
    onJump(line: number): void;
  },
) {
  const { marks, agent, hits, rows, viewRows, height, revision } = props;
  // Runs of marks once per set of marks; the lanes once per runs, hits and layout revision. A
  // render that only moves the caret places one tick.
  const runs = useMemo(() => markRuns(marks), [marks]);
  const lanes = useMemo(
    () => laneTicks({ ...props, runs }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- rowOf and rowsOf read the layout, which `revision` stands for.
    [runs, agent, hits, rows, viewRows, height, revision],
  );
  const caret = caretTick(props);
  const jumpTo = useRef(props.onJump);
  useLayoutEffect(() => {
    jumpTo.current = props.onJump;
  });
  const jump = useCallback((line: number) => jumpTo.current(line), []);
  if (lanes.length === 0 && !caret) return null;
  return (
    <div
      aria-hidden
      data-overview-ruler
      className="pointer-events-none absolute top-0 right-0 z-[2] w-2.5"
      style={{ height: props.height }}
    >
      <Ticks ticks={lanes} onJump={jump} />
      {caret && <Tick tick={caret} onJump={jump} />}
    </div>
  );
}

/** The change and hit ticks: drawn again only when they change, never for a caret move. */
const Ticks = memo(function Ticks(props: {
  ticks: readonly OverviewTick[];
  onJump(line: number): void;
}) {
  return props.ticks.map((tick) => (
    <Tick key={`${tick.lane}-${tick.top}`} tick={tick} onJump={props.onJump} />
  ));
});

function Tick(props: { tick: OverviewTick; onJump(line: number): void }) {
  const { tick } = props;
  return (
    <span
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
  );
}
