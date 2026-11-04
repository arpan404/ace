import type { Box, Point } from "./fleet-map-geometry.ts";
import { placeNodes, type Cell } from "./fleet-map-place.ts";
import {
  gapMargin,
  laneGap,
  markOf,
  routeWires,
  type RouteEnd,
  type Row,
} from "./fleet-map-route.ts";
import { relayEnd, type FleetMap, type WireKind, type ZoneId } from "./fleet-map-types.ts";

/*
 * Where the Fleet map draws everything, from its facts. Pure and deterministic: the same facts
 * always make the same picture. `fleet-map-place.ts` picks each node's cell (relay band, this
 * computer with its networks' zones, everything else below), this turns cells into positions,
 * draws each zone around its members, and routes the wires (`fleet-map-route.ts`), widening any
 * gap between rows that more wires run along than it fits.
 */

export type { Box, Point };

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
}

export interface PlacedZone {
  id: ZoneId;
  box: Box;
  /** Where its name goes, just above its top edge, at its left (local) or right (tailnet). */
  label: Point & { anchor: "start" | "end" };
}

export interface PlacedWire {
  /** The node it brings in. */
  node: string;
  from: string;
  kind: WireKind;
  relayed: boolean;
  label: string;
  points: readonly Point[];
  /** On a stretch only this wire uses, where a broken wire's cross sits. */
  mark: Point;
  labelAt: Point & { anchor: "start" | "middle" };
}

export interface MapLayout {
  width: number;
  height: number;
  cloud: Point | undefined;
  nodes: readonly PlacedNode[];
  zones: readonly PlacedZone[];
  wires: readonly PlacedWire[];
  agentLinks: readonly { a: string; b: string; points: readonly [Point, Point, Point] }[];
}

/** A node's box around its centre: artwork above, name and status below. */
export const nodeExtent = { left: 60, right: 60, top: 34, bottom: 58 };
export const cloudExtent = { left: 84, right: 84, top: 42, bottom: 32 };
const column = 160;
const zonePad: Record<ZoneId, { side: number; top: number; bottom: number }> = {
  lan: { side: 14, top: 20, bottom: 14 },
  tailnet: { side: 26, top: 40, bottom: 26 },
};
const margin = 16;
/** Where wires meet a row: above its nodes, and under their words (the cloud's own bottom). */
const meetTop = 30;
const meetBottom = 64;
const cloudMeetBottom = 30;

export const nodeBox = (point: Point): Box => ({
  x: point.x - nodeExtent.left,
  y: point.y - nodeExtent.top,
  width: nodeExtent.left + nodeExtent.right,
  height: nodeExtent.top + nodeExtent.bottom,
});

const cloudBox = (point: Point): Box => ({
  x: point.x - cloudExtent.left,
  y: point.y - cloudExtent.top,
  width: cloudExtent.left + cloudExtent.right,
  height: cloudExtent.top + cloudExtent.bottom,
});

type RowKey = { band: "cloud" | Cell["band"]; row: number };

/** How far apart two rows' centres start, before any gap widens for its wires. */
function basePitch(above: RowKey, below: RowKey): number {
  if (above.band === "cloud") return below.band === "top" ? 156 : 176;
  if (above.band === "top") return below.band === "top" ? 160 : 184;
  return 168;
}

export function fleetMapLayout(map: FleetMap, ownId: string): MapLayout {
  const cells = placeNodes(map, ownId);
  const count = (band: Cell["band"]) =>
    Math.max(
      0,
      ...[...cells.values()].filter((cell) => cell.band === band).map((cell) => cell.row + 1),
    );
  const keys: RowKey[] = [
    ...(map.relay ? [{ band: "cloud" as const, row: 0 }] : []),
    ...(["top", "middle", "bottom"] as const).flatMap((band) =>
      Array.from({ length: count(band) }, (_, row) => ({ band, row })),
    ),
  ];
  const indexOf = (cell: Cell) =>
    keys.findIndex((key) => key.band === cell.band && key.row === cell.row);
  const extra = keys.map(() => 0);
  const wireAsks = map.nodes.flatMap((node) =>
    node.wire ? [{ node: node.id, from: node.wire.from }] : [],
  );
  let ys: number[] = [];
  let routes = routeWires({ ends: new Map(), wires: [], rows: [], obstacles: [], trunk: ownId });
  let placed: PlacedNode[] = [];
  let cloud: Point | undefined;
  // Place, route, and widen every gap more wires run along than it fits, until all fit.
  for (let pass = 0; pass < 6; pass += 1) {
    ys = keys.map(() => 0);
    for (let index = 1; index < keys.length; index += 1) {
      const above = keys[index - 1];
      const below = keys[index];
      if (above && below)
        ys[index] = (ys[index - 1] ?? 0) + basePitch(above, below) + (extra[index] ?? 0);
    }
    const rows: Row[] = keys.map((key, index) => {
      const y = ys[index] ?? 0;
      return key.band === "cloud"
        ? { y, top: y - cloudExtent.top, bottom: y + cloudMeetBottom }
        : { y, top: y - meetTop, bottom: y + meetBottom };
    });
    cloud = map.relay ? { x: 0, y: ys[0] ?? 0 } : undefined;
    placed = map.nodes.flatMap((node) => {
      const cell = cells.get(node.id);
      return cell ? [{ id: node.id, x: cell.col * column, y: ys[indexOf(cell)] ?? 0 }] : [];
    });
    const ends = new Map<string, RouteEnd>(
      placed.map((node) => {
        const cell = cells.get(node.id);
        return [node.id, { ...node, row: cell ? indexOf(cell) : 0, cloud: false }] as const;
      }),
    );
    if (cloud) ends.set(relayEnd, { id: relayEnd, ...cloud, row: 0, cloud: true });
    routes = routeWires({
      ends,
      wires: wireAsks,
      rows,
      obstacles: [
        ...placed.map((node) => ({ id: node.id, box: nodeBox(node) })),
        ...(cloud ? [{ id: relayEnd, box: cloudBox(cloud) }] : []),
      ],
      trunk: ownId,
    });
    let widened = false;
    for (const [gap, lanes] of routes.lanes.entries()) {
      const above = rows[gap];
      const below = rows[gap + 1];
      if (!above || !below) continue;
      const short = lanes * laneGap + gapMargin * 2 - (below.top - above.bottom);
      if (short > 0) {
        extra[gap + 1] = (extra[gap + 1] ?? 0) + Math.ceil(short);
        widened = true;
      }
    }
    if (!widened) break;
  }

  const zones = map.zones.flatMap((zone) => {
    const members = placed.filter((node) =>
      map.nodes.find((entry) => entry.id === node.id)?.zones.includes(zone.id),
    );
    if (!members.length) return [];
    const pad = zonePad[zone.id];
    const left = Math.min(...members.map((node) => node.x)) - nodeExtent.left - pad.side;
    const right = Math.max(...members.map((node) => node.x)) + nodeExtent.right + pad.side;
    const top = Math.min(...members.map((node) => node.y)) - nodeExtent.top - pad.top;
    const bottom = Math.max(...members.map((node) => node.y)) + nodeExtent.bottom + pad.bottom;
    const box = { x: left, y: top, width: right - left, height: bottom - top };
    const label =
      zone.id === "lan"
        ? { x: left + 4, y: top - 7, anchor: "start" as const }
        : { x: right - 4, y: top - 7, anchor: "end" as const };
    return [{ id: zone.id, box, label }];
  });

  const paths = [...routes.paths];
  const wires = map.nodes.flatMap((node) => {
    const wire = node.wire;
    const points = routes.paths.get(node.id);
    if (!wire || !points) return [];
    const others = paths.filter(([id]) => id !== node.id).map(([, path]) => path);
    const { mark, label } = markOf(points, others);
    return [
      {
        node: node.id,
        from: wire.from,
        kind: wire.kind,
        relayed: wire.relayed,
        label: wire.label,
        points,
        mark,
        labelAt: label,
      },
    ];
  });

  const at = new Map(placed.map((node) => [node.id, node]));
  const agentLinks = map.agentLinks.flatMap(({ a, b }) => {
    const p = at.get(a);
    const q = at.get(b);
    if (!p || !q) return [];
    const start = { x: p.x, y: p.y - nodeExtent.top + 4 };
    const end = { x: q.x, y: q.y - nodeExtent.top + 4 };
    const bend = {
      x: (start.x + end.x) / 2 + (end.y - start.y) * 0.25,
      y: (start.y + end.y) / 2 - Math.abs(end.x - start.x) * 0.25 - 24,
    };
    return [{ a, b, points: [start, bend, end] as const }];
  });

  return normalized({ cloud, nodes: placed, zones, wires, agentLinks });
}

/** Moves everything so the picture starts at the margin, and sizes it to fit. */
function normalized(layout: Omit<MapLayout, "width" | "height">): MapLayout {
  const boxes: Box[] = [
    ...layout.nodes.map(nodeBox),
    ...(layout.cloud ? [cloudBox(layout.cloud)] : []),
    ...layout.zones.flatMap((zone) => [
      zone.box,
      {
        x: zone.label.anchor === "end" ? zone.label.x - 180 : zone.label.x,
        y: zone.label.y - 14,
        width: 180,
        height: 16,
      },
    ]),
    ...layout.wires.flatMap((wire) => [
      ...wire.points.map((point) => ({ ...point, width: 0, height: 0 })),
      {
        x: wire.labelAt.anchor === "middle" ? wire.labelAt.x - 50 : wire.labelAt.x,
        y: wire.labelAt.y - 13,
        width: 100,
        height: 16,
      },
    ]),
  ];
  const minX = Math.min(0, ...boxes.map((box) => box.x)) - margin;
  const minY = Math.min(0, ...boxes.map((box) => box.y)) - margin;
  const maxX = Math.max(0, ...boxes.map((box) => box.x + box.width)) + margin;
  const maxY = Math.max(0, ...boxes.map((box) => box.y + box.height)) + margin;
  const move = <T extends Point>(point: T): T => ({
    ...point,
    x: point.x - minX,
    y: point.y - minY,
  });
  return {
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
    cloud: layout.cloud && move(layout.cloud),
    nodes: layout.nodes.map(move),
    zones: layout.zones.map((zone) => ({ ...zone, box: move(zone.box), label: move(zone.label) })),
    wires: layout.wires.map((wire) => ({
      ...wire,
      points: wire.points.map(move),
      mark: move(wire.mark),
      labelAt: move(wire.labelAt),
    })),
    agentLinks: layout.agentLinks.map((link) => ({
      ...link,
      points: [move(link.points[0]), move(link.points[1]), move(link.points[2])] as const,
    })),
  };
}
