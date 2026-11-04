/*
 * How a Fleet map wire runs between two ends. A wire meets a node at its top when the other end
 * is above, under its name when it's below, and at its side when they're level, so it never
 * crosses a node's words. It goes straight when nothing is in the way; otherwise it drops into
 * the gap between rows, runs along it, and climbs or drops into the far end, passing other rows
 * through the gaps between columns. Pure.
 */

export interface Point {
  x: number;
  y: number;
}

/** One row of nodes (or the cloud): its centre and how far its boxes reach up and down. */
export interface Row {
  y: number;
  top: number;
  bottom: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Route {
  points: Point[];
  mark: Point;
  labelAt: Point & { anchor: "start" | "middle" };
}

/** Where a wire meets a node, relative to its centre. */
const attach = { top: -30, bottom: 64, side: 32, sideY: -4, cloudBottom: 30 };
/** How close wires sharing a gap run beside each other. */
const laneGap = 7;
/** Lanes either side of a gap's middle: they stay clear of the rows around it. */
const lanesPerGap = 3;

/** Whether the segment p→q passes through `box` (Liang–Barsky clipping). */
export function crosses(p: Point, q: Point, box: Box): boolean {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let low = 0;
  let high = 1;
  const edges: [number, number][] = [
    [-dx, p.x - box.x],
    [dx, box.x + box.width - p.x],
    [-dy, p.y - box.y],
    [dy, box.y + box.height - p.y],
  ];
  for (const [step, room] of edges) {
    if (step === 0) {
      if (room < 0) return false;
      continue;
    }
    const t = room / step;
    if (step < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low > high) return false;
  }
  return true;
}

function endOf(at: Point, other: Point, cloud: boolean): Point {
  if (cloud) return { x: at.x, y: at.y + attach.cloudBottom };
  const dy = other.y - at.y;
  if (Math.abs(dy) < 30)
    return { x: at.x + Math.sign(other.x - at.x || 1) * attach.side, y: at.y + attach.sideY };
  return dy < 0 ? { x: at.x, y: at.y + attach.top } : { x: at.x, y: at.y + attach.bottom };
}

const midpoint = (p: Point, q: Point) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });

/** The label beside a segment's middle: to the right of an upright one, above any other. */
function labelBeside(p: Point, q: Point): Route["labelAt"] {
  const mid = midpoint(p, q);
  return Math.abs(q.x - p.x) < 20
    ? { x: mid.x + 16, y: mid.y + 4, anchor: "start" }
    : { x: mid.x, y: mid.y - 14, anchor: "middle" };
}

export function routeWire(input: {
  from: Point & { id: string };
  to: Point & { id: string };
  /** `from` is the relay cloud. */
  cloud: boolean;
  rows: readonly Row[];
  obstacles: readonly { id: string; box: Box }[];
  column: number;
  /** How many wires already run along each gap, shared by every wire of one map. */
  lanes: Map<number, number>;
}): Route {
  const { from, to, rows } = input;
  const start = endOf(from, to, input.cloud);
  const end = endOf(to, from, false);
  const inWay = input.obstacles.filter(
    (entry) =>
      entry.id !== from.id &&
      entry.id !== to.id &&
      crosses(start, end, {
        x: entry.box.x - 6,
        y: entry.box.y - 6,
        width: entry.box.width + 12,
        height: entry.box.height + 12,
      }),
  );
  if (inWay.length === 0)
    return { points: [start, end], mark: midpoint(start, end), labelAt: labelBeside(start, end) };

  const rowOf = (point: Point) =>
    Math.max(
      0,
      rows.findIndex((row) => row.y === point.y),
    );
  /** The middle of the gap under row `index`, moved aside for each wire already in it. */
  const gap = (index: number) => {
    const row = rows[index];
    const next = rows[index + 1];
    const base = row ? (next ? (row.bottom + next.top) / 2 : row.bottom + 24) : 0;
    const used = input.lanes.get(index) ?? 0;
    input.lanes.set(index, used + 1);
    // Lanes alternate either side of the middle and wrap before they leave the gap.
    const lane = used % (lanesPerGap * 2 + 1);
    const offset = lane === 0 ? 0 : (lane % 2 ? -1 : 1) * Math.ceil(lane / 2) * laneGap;
    return base + offset;
  };
  const a = rowOf(from);
  const b = rowOf(to);
  // Lower, level or higher: out of the near end into the gap beside its row, along it, and into
  // the far end from the gap beside its row.
  const down = b >= a;
  const leave = input.cloud
    ? start
    : { x: from.x, y: from.y + (down ? attach.bottom : attach.top) };
  const enter = { x: to.x, y: to.y + (b > a ? attach.top : attach.bottom) };
  const nearGap = down ? a : a - 1;
  const farGap = b === a ? nearGap : down ? b - 1 : b;
  const first = gap(nearGap);
  const last = farGap === nearGap ? first : gap(farGap);
  const points: Point[] = [leave, { x: from.x, y: first }];
  if (farGap !== nearGap) {
    // Through the rows between, in the gap between columns beside the far end.
    const side = to.x - (from.x <= to.x ? 1 : -1) * (input.column / 2);
    points.push({ x: side, y: first }, { x: side, y: last });
  }
  points.push({ x: to.x, y: last }, enter);
  // The label on the run that ends at the node, else on the climb into it.
  const runFrom = points[points.length - 3] ?? leave;
  const runTo = points[points.length - 2] ?? enter;
  const run = Math.abs(runTo.x - runFrom.x) >= 70 ? [runFrom, runTo] : [runTo, enter];
  const [p = leave, q = enter] = run;
  return { points, mark: midpoint(p, q), labelAt: labelBeside(p, q) };
}
