import {
  crosses,
  distanceToSegment,
  inflate,
  segmentsOf,
  type Box,
  type Point,
} from "./fleet-map-geometry.ts";

/*
 * How the Fleet map's wires run. A wire meets a node at its top when the other end is above, under
 * its name when it's below, and at its side when they're level, so it never crosses a node's
 * words. It goes straight when nothing is in the way. Otherwise it drops into the gap between rows
 * and runs along it; one that has rows to cross goes down the trunk, the clear column under this
 * computer. No two wires share any stretch: each has its own point on every node edge it meets
 * (spread along the edge), its own lane in every gap and its own line down the trunk. Pure.
 */

export type { Point };

/** A row of nodes (or the cloud): its centre and the lines wires meet it at, above and below. */
export interface Row {
  y: number;
  top: number;
  bottom: number;
}

export interface RouteEnd extends Point {
  id: string;
  /** Its row's index in `rows`. */
  row: number;
  cloud: boolean;
}

/** Wires sharing a gap run this far apart. */
export const laneGap = 6;
/** Clear space a gap keeps above and below its lanes. */
export const gapMargin = 14;

type Edge = "top" | "bottom" | "left" | "right";
type Plan =
  | { kind: "straight"; from: Edge; to: Edge }
  | { kind: "same"; gap: number }
  | { kind: "down"; gap: number }
  | { kind: "trunk"; first: number; gap: number };

const attach: Record<Edge, Point> = {
  top: { x: 0, y: -30 },
  bottom: { x: 0, y: 64 },
  left: { x: -32, y: -4 },
  right: { x: 32, y: -4 },
};
const cloudBottom = 30;

function edgePoint(end: RouteEnd, edge: Edge, offset = 0): Point {
  if (end.cloud) return { x: end.x + offset, y: end.y + cloudBottom };
  const at = attach[edge];
  return edge === "left" || edge === "right"
    ? { x: end.x + at.x, y: end.y + at.y + offset }
    : { x: end.x + offset, y: end.y + at.y };
}

/** Spacing between wires meeting one edge, by how many meet it. */
function spacing(edge: Edge, cloud: boolean, count: number): number {
  if (count <= 1) return 0;
  if (edge === "left" || edge === "right") return Math.min(6, 20 / (count - 1));
  return Math.min(cloud ? 12 : 8, (cloud ? 110 : 100) / (count - 1));
}

export interface Routes {
  paths: Map<string, Point[]>;
  /** How many wires run along each gap (gap i lies under row i). */
  lanes: number[];
}

type Wire = { node: string; from: RouteEnd; to: RouteEnd };

export function routeWires(input: {
  ends: ReadonlyMap<string, RouteEnd>;
  wires: readonly { node: string; from: string }[];
  rows: readonly Row[];
  obstacles: readonly { id: string; box: Box }[];
  /** This computer: wires that cross rows go down its column. */
  trunk: string;
}): Routes {
  const { ends, rows } = input;
  const trunk = ends.get(input.trunk);
  const wires: Wire[] = input.wires.flatMap((wire) => {
    const from = ends.get(wire.from);
    const to = ends.get(wire.node);
    return from && to ? [{ node: wire.node, from, to }] : [];
  });
  const clear = (wire: Wire, p: Point, q: Point) =>
    !input.obstacles.some(
      (entry) =>
        entry.id !== wire.from.id &&
        entry.id !== wire.to.id &&
        crosses(p, q, inflate(entry.box, 6)),
    );
  const bent = new Set<string>();
  let result: Routes = { paths: new Map(), lanes: [] };
  // Straight wires that clip a node once spread along their edges bend, and the rest re-spread.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const plans = new Map<string, Plan>();
    for (const wire of wires) plans.set(wire.node, planOf(wire, bent, clear, input.trunk, !!trunk));
    result = build(wires, plans, rows, trunk);
    const clipped = wires.filter((wire) => {
      const path = result.paths.get(wire.node);
      if (plans.get(wire.node)?.kind !== "straight" || !path) return false;
      const [p, q] = [path[0], path.at(-1)];
      return !p || !q || !clear(wire, p, q);
    });
    if (clipped.length === 0) break;
    for (const wire of clipped) bent.add(wire.node);
  }
  return result;
}

function planOf(
  wire: Wire,
  bent: ReadonlySet<string>,
  clear: (wire: Wire, p: Point, q: Point) => boolean,
  trunk: string,
  hasTrunk: boolean,
): Plan {
  const { from, to } = wire;
  const sameRow = to.row === from.row;
  const below = to.row > from.row;
  const edges: [Edge, Edge] = sameRow
    ? to.x < from.x
      ? ["left", "right"]
      : ["right", "left"]
    : below
      ? ["bottom", "top"]
      : ["top", "bottom"];
  const straight =
    !bent.has(wire.node) && clear(wire, edgePoint(from, edges[0]), edgePoint(to, edges[1]));
  if (straight || (!sameRow && !below)) return { kind: "straight", from: edges[0], to: edges[1] };
  if (sameRow) return { kind: "same", gap: from.row };
  if (from.cloud || from.id === trunk || to.row === from.row + 1 || !hasTrunk)
    return { kind: "down", gap: to.row - 1 };
  return { kind: "trunk", first: from.row, gap: to.row - 1 };
}

const byName = (a: { node: string }, b: { node: string }) => a.node.localeCompare(b.node);
const trunkKey = (node: string) => `${node}\u0000trunk`;
const outKey = (node: string) => `${node}\u0000out`;

function build(
  wires: readonly Wire[],
  plans: ReadonlyMap<string, Plan>,
  rows: readonly Row[],
  trunk: RouteEnd | undefined,
): Routes {
  // Who meets each edge, ordered along it by where they come from, so they don't cross there.
  const edges = new Map<string, { node: string; key: number }[]>();
  const edgeKey = (end: RouteEnd, edge: Edge) => `${end.id}:${end.cloud ? "bottom" : edge}`;
  const meet = (end: RouteEnd, edge: Edge, node: string, other: Point) => {
    const key = edgeKey(end, edge);
    edges.set(key, [
      ...(edges.get(key) ?? []),
      { node, key: edge === "left" || edge === "right" ? other.y : other.x },
    ]);
  };
  for (const { node, from, to } of wires) {
    const plan = plans.get(node);
    if (!plan) continue;
    if (plan.kind === "straight") {
      meet(from, plan.from, node, to);
      meet(to, plan.to, node, from);
    } else {
      meet(from, "bottom", node, to);
      meet(to, plan.kind === "same" ? "bottom" : "top", node, from);
      if (plan.kind === "trunk" && trunk) meet(trunk, "bottom", trunkKey(node), to);
    }
  }
  const at = (end: RouteEnd, edge: Edge, node: string) => {
    const list = (edges.get(edgeKey(end, edge)) ?? []).toSorted(
      (a, b) => a.key - b.key || a.node.localeCompare(b.node),
    );
    const index = list.findIndex((entry) => entry.node === node);
    const raw = (index - (list.length - 1) / 2) * spacing(edge, end.cloud, list.length);
    // Bottom edges on even offsets, top edges on odd ones: a wire leaving a node never lines up
    // with one entering the node under it.
    const snapped =
      edge === "bottom" && !end.cloud
        ? Math.round(raw / 2) * 2
        : edge === "top"
          ? Math.round((raw - 1) / 2) * 2 + 1
          : raw;
    return edgePoint(end, edge, snapped);
  };
  const trunkX = (node: string, to: RouteEnd) =>
    trunk ? at(trunk, "bottom", trunkKey(node)).x : to.x;

  // Who runs along each gap: those turning down further on take the upper lanes, those climbing
  // into a node above the lower ones, the longest runs outermost, so turns don't cross runs.
  const gaps = new Map<number, { node: string; down: boolean; length: number }[]>();
  const run = (gap: number, node: string, down: boolean, length: number) =>
    gaps.set(gap, [...(gaps.get(gap) ?? []), { node, down, length }]);
  for (const { node, from, to } of wires) {
    const plan = plans.get(node);
    if (!plan || plan.kind === "straight") continue;
    const start = at(from, "bottom", node).x;
    if (plan.kind === "trunk") {
      const middle = trunkX(node, to);
      run(plan.first, outKey(node), true, Math.abs(middle - start));
      run(plan.gap, node, true, Math.abs(to.x - middle));
    } else run(plan.gap, node, plan.kind === "down", Math.abs(to.x - start));
  }
  const laneY = (gap: number, node: string) => {
    const list = gaps.get(gap) ?? [];
    // Climbs into the row above take the upper lanes and drops into the row below the lower, so
    // no climb and drop in one column meet; within each, longer runs sit further from their turn.
    const ordered = [
      ...list
        .filter((entry) => !entry.down)
        .toSorted((a, b) => a.length - b.length || byName(a, b)),
      ...list.filter((entry) => entry.down).toSorted((a, b) => b.length - a.length || byName(a, b)),
    ];
    const above = rows[gap];
    const under = rows[gap + 1];
    const middle = above ? (under ? (above.bottom + under.top) / 2 : above.bottom + 24) : 0;
    const index = ordered.findIndex((entry) => entry.node === node);
    return middle + (index - (ordered.length - 1) / 2) * laneGap;
  };

  const paths = new Map<string, Point[]>();
  for (const { node, from, to } of wires) {
    const plan = plans.get(node);
    if (!plan) continue;
    if (plan.kind === "straight") {
      paths.set(node, [at(from, plan.from, node), at(to, plan.to, node)]);
      continue;
    }
    const start = at(from, "bottom", node);
    const end = at(to, plan.kind === "same" ? "bottom" : "top", node);
    const last = laneY(plan.gap, node);
    if (plan.kind === "trunk") {
      const middle = trunkX(node, to);
      const first = laneY(plan.first, outKey(node));
      paths.set(node, [
        start,
        { x: start.x, y: first },
        { x: middle, y: first },
        { x: middle, y: last },
        { x: end.x, y: last },
        end,
      ]);
    } else paths.set(node, [start, { x: start.x, y: last }, { x: end.x, y: last }, end]);
  }
  const lanes = rows.slice(0, -1).map((_, gap) => gaps.get(gap)?.length ?? 0);
  return { paths, lanes };
}

/**
 * Where a broken wire's cross and its label go: a point on its own line, as near the node it
 * brings in as possible, clear of every other wire and away from its own bends.
 */
export function markOf(
  path: readonly Point[],
  others: readonly (readonly Point[])[],
): { mark: Point; label: Point & { anchor: "start" | "middle" } } {
  const segments = segmentsOf(path).toReversed();
  const otherSegments = others.flatMap(segmentsOf);
  const clearance = (point: Point) =>
    Math.min(12, ...otherSegments.map(([p, q]) => distanceToSegment(point, p, q)));
  // Nearest the node first, middles of each stretch before its ends; the first with room wins,
  // else the roomiest.
  const steps = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.15, 0.85, 0.1, 0.9];
  let best: { mark: Point; along: [Point, Point]; room: number } | undefined;
  for (const segment of segments) {
    const [p, q] = segment;
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    for (const t of steps) {
      if (length * Math.min(t, 1 - t) < 10) continue;
      const mark = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      const room = clearance(mark);
      if (!best || room > best.room) best = { mark, along: segment, room };
      if (room >= 12) break;
    }
    if (best && best.room >= 12) break;
  }
  const origin = path[0] ?? { x: 0, y: 0 };
  const [p, q] = best?.along ?? segments[0] ?? [origin, origin];
  const mark = best?.mark ?? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const upright = Math.abs(q.x - p.x) < Math.abs(q.y - p.y);
  return {
    mark,
    label: upright
      ? { x: mark.x + 14, y: mark.y + 4, anchor: "start" }
      : { x: mark.x, y: mark.y - 13, anchor: "middle" },
  };
}
