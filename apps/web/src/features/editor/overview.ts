import type { Range } from "@ace/editor";
import type { LineMark } from "@ace/ui-core";
import type { AgentMark } from "./change-bars.tsx";

/*
 * The overview ruler's ticks: where in the whole file the changes, the agents' lines, the find
 * hits and the caret are, scaled to the ruler's height. At most one tick per lane per pixel, so
 * the work and the DOM follow the marks and the ruler's height, never the file's length.
 */

export type TickLane = "change" | "hit" | "caret";

export interface OverviewTick {
  lane: TickLane;
  /** What the tick stands for: a change's kind, "agent", "hit" or "caret". */
  kind: LineMark | "agent" | "hit" | "caret";
  /** 0-based line it jumps to. */
  line: number;
  /** Pixels from the ruler's top. */
  top: number;
  height: number;
}

export interface OverviewInput {
  /** The file's visual rows, and how many fit the view. */
  rows: number;
  viewRows: number;
  /** The ruler's height in pixels. */
  height: number;
  /** A line's first visual row, and how many rows it takes. */
  rowOf(line: number): number;
  rowsOf(line: number): number;
  marks: ReadonlyMap<number, LineMark> | undefined;
  agent: readonly AgentMark[] | undefined;
  hits: readonly Range[];
  caretLine: number | undefined;
}

/** The fewest pixels a tick is drawn. */
const least = 2;

export function overviewTicks(input: OverviewInput): OverviewTick[] {
  // A file shorter than the view maps its rows where they are drawn, not stretched to the end.
  const span = Math.max(1, input.rows, input.viewRows);
  const scale = input.height / span;
  const ticks: OverviewTick[] = [];
  const taken = new Map<TickLane, Set<number>>();
  const add = (lane: TickLane, kind: OverviewTick["kind"], line: number, last = line) => {
    const top = Math.floor(input.rowOf(line) * scale);
    const bottom = Math.ceil((input.rowOf(last) + input.rowsOf(last)) * scale);
    let used = taken.get(lane);
    if (!used) taken.set(lane, (used = new Set()));
    if (used.has(top)) return;
    used.add(top);
    ticks.push({ lane, kind, line, top, height: Math.max(least, bottom - top) });
  };
  // Agents' lines first: a line both an agent and the commit marked reads as the agent's.
  for (const mark of input.agent ?? [])
    add("change", "agent", mark.start, Math.max(mark.start, mark.end - 1));
  if (input.marks) for (const [line, kind] of input.marks) add("change", kind, line - 1);
  for (const hit of input.hits) add("hit", "hit", hit.start.line);
  if (input.caretLine !== undefined) add("caret", "caret", input.caretLine);
  return ticks;
}
