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

/** Rows to pixels: a file shorter than the view maps its rows where they are drawn. */
function scaleOf(input: Pick<OverviewInput, "rows" | "viewRows" | "height">): number {
  return input.height / Math.max(1, input.rows, input.viewRows);
}

/**
 * The change and find-hit lanes: at most one tick per lane per pixel. Linear in the marks and
 * hits; the caller keeps them while those and the layout's size stay the same.
 */
export function laneTicks(input: Omit<OverviewInput, "caretLine">): OverviewTick[] {
  const scale = scaleOf(input);
  const ticks: OverviewTick[] = [];
  const taken = new Map<TickLane, Set<number>>();
  const add = (lane: TickLane, kind: OverviewTick["kind"], line: number, last = line) => {
    const top = Math.floor(input.rowOf(line) * scale);
    let used = taken.get(lane);
    if (!used) taken.set(lane, (used = new Set()));
    if (used.has(top)) return;
    used.add(top);
    const bottom = Math.ceil((input.rowOf(last) + input.rowsOf(last)) * scale);
    ticks.push({ lane, kind, line, top, height: Math.max(least, bottom - top) });
  };
  // Agents' lines first: a line both an agent and the commit marked reads as the agent's.
  for (const mark of input.agent ?? [])
    add("change", "agent", mark.start, Math.max(mark.start, mark.end - 1));
  if (input.marks) for (const [line, kind] of input.marks) add("change", kind, line - 1);
  for (const hit of input.hits) add("hit", "hit", hit.start.line);
  return ticks;
}

/** The caret's tick: its own lane, worked out on its own as the caret moves. */
export function caretTick(
  input: Pick<OverviewInput, "rows" | "viewRows" | "height" | "rowOf" | "caretLine">,
): OverviewTick | undefined {
  if (input.caretLine === undefined) return undefined;
  const top = Math.floor(input.rowOf(input.caretLine) * scaleOf(input));
  return { lane: "caret", kind: "caret", line: input.caretLine, top, height: least };
}

export function overviewTicks(input: OverviewInput): OverviewTick[] {
  const caret = caretTick(input);
  return caret ? [...laneTicks(input), caret] : laneTicks(input);
}
