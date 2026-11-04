import { routeWire, type Point, type Row } from "./fleet-map-route.ts";
import {
  relayEnd,
  type FleetMap,
  type MapNode,
  type WireKind,
  type ZoneId,
} from "./fleet-map-types.ts";

/*
 * Where the Fleet map draws everything, from its facts. Pure and deterministic: the same facts
 * always make the same picture. ace's relay is a cloud on top with what it reaches in a band
 * under it (the middle column left free for this computer's own wire); this computer sits in the
 * middle with its devices to its left, the local network's machines beside it on the left and
 * the tailnet's on the right, each network a zone around its members; whatever reaches it some
 * other way, or doesn't reach it, sits in rows below, outside the zones. Groups wrap into rows
 * three wide, so no two nodes overlap however many there are.
 */

export type { Point };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /** On the line, where a broken wire's ✕ sits. */
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
const perRow = 3;
const rowPitch = 168;
/** Space above the middle band for the zones' names. */
const zoneHead = 184;
const zonePad: Record<ZoneId, { side: number; top: number; bottom: number }> = {
  lan: { side: 14, top: 20, bottom: 14 },
  tailnet: { side: 26, top: 40, bottom: 26 },
};
const margin = 16;

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

/** The top band's rows, under the cloud. */
const topY = (row: number) => 156 + row * 160;

type Slot = { col: number; row: number };

/** `count` slots `perRow`-ish wide over `rows` rows, stepping away from the centre by `dir`. */
function block(count: number, rows: number, first: number, dir: 1 | -1): Slot[] {
  const cols = Math.ceil(count / rows);
  return Array.from({ length: count }, (_, index) => ({
    col: first + dir * (index % cols),
    row: Math.floor(index / cols),
  }));
}

const isOwn = (node: MapNode, own: string) => node.id === own;

/** Which band and group a node goes in, from how it reaches this computer. */
function groupOf(node: MapNode, own: string) {
  const wire = node.wire;
  if (isOwn(node, own)) return "own";
  if (wire?.from === relayEnd) return "top";
  if (wire?.from === own) {
    if (node.role === "device") return "devices";
    if (node.zones.includes("lan") && !node.zones.includes("tailnet")) return "lan";
    if (node.zones.includes("tailnet")) return "tailnet";
    if (wire.kind === "direct") return "other";
  }
  return "bottom";
}

/** Places the bottom rows: each node as near the column of what it reaches through as it fits. */
function placeBottom(nodes: readonly MapNode[], colOf: Map<string, number>): Map<string, Slot> {
  const taken = new Set<string>();
  const slots = new Map<string, Slot>();
  for (const node of nodes) {
    const want = colOf.get(node.wire?.from ?? "") ?? 0;
    for (let row = 0, placed = false; !placed; row += 1)
      for (let step = 0; step <= perRow && !placed; step += 1)
        for (const col of step === 0 ? [want] : [want + step, want - step]) {
          if (taken.has(`${col}:${row}`)) continue;
          taken.add(`${col}:${row}`);
          slots.set(node.id, { col, row });
          colOf.set(node.id, col);
          placed = true;
          break;
        }
  }
  return slots;
}

export function fleetMapLayout(map: FleetMap, ownId: string): MapLayout {
  const groups = new Map<string, MapNode[]>();
  for (const node of map.nodes) {
    const group = groupOf(node, ownId);
    groups.set(group, [...(groups.get(group) ?? []), node]);
  }
  const of = (group: string) => groups.get(group) ?? [];
  const slots = new Map<string, Slot & { band: "top" | "middle" | "bottom" }>();
  // The top band: alternately left and right of the middle column, three a side per row.
  of("top").forEach((node, index) => {
    const side = index % 2 === 0 ? -1 : 1;
    const nth = Math.floor(index / 2);
    slots.set(node.id, {
      band: "top",
      col: side * (1 + (nth % perRow)),
      row: Math.floor(nth / perRow),
    });
  });
  // The middle band: devices | local network | this computer | tailnet | other networks.
  const sizes = ["devices", "lan", "tailnet", "other"].map((group) => of(group).length);
  const rows = Math.max(1, ...sizes.map((size) => Math.ceil(size / perRow)));
  const cols = (group: string) => Math.ceil(of(group).length / rows);
  slots.set(ownId, { band: "middle", col: 0, row: 0 });
  const middle: [string, number, 1 | -1][] = [
    ["lan", -1, -1],
    ["devices", -1 - cols("lan"), -1],
    ["tailnet", 1, 1],
    ["other", 1 + cols("tailnet"), 1],
  ];
  for (const [group, first, dir] of middle)
    block(of(group).length, rows, first, dir).forEach((slot, index) => {
      const node = of(group)[index];
      if (node) slots.set(node.id, { band: "middle", ...slot });
    });
  const colOf = new Map([...slots].map(([id, slot]) => [id, slot.col]));
  for (const [id, slot] of placeBottom(of("bottom"), colOf))
    slots.set(id, { band: "bottom", ...slot });

  // Rows top to bottom, then each slot's point.
  const cloud = map.relay ? { x: 0, y: 0 } : undefined;
  const topRows = Math.max(
    0,
    ...[...slots.values()].filter((s) => s.band === "top").map((s) => s.row + 1),
  );
  const bottomRows = Math.max(
    0,
    ...[...slots.values()].filter((s) => s.band === "bottom").map((s) => s.row + 1),
  );
  const middleY = (row: number) =>
    (topRows ? topY(topRows - 1) + zoneHead : cloud ? zoneHead - 8 : 0) + row * rowPitch;
  const bottomY = (row: number) => middleY(rows - 1) + rowPitch + row * rowPitch;
  const yOf = (slot: Slot & { band: string }) =>
    slot.band === "top"
      ? topY(slot.row)
      : slot.band === "middle"
        ? middleY(slot.row)
        : bottomY(slot.row);
  const placed = map.nodes.flatMap((node) => {
    const slot = slots.get(node.id);
    return slot ? [{ id: node.id, x: slot.col * column, y: yOf(slot) }] : [];
  });
  const at = new Map(placed.map((node) => [node.id, node]));

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

  // The rows wires run between: the cloud's, then every row of nodes, top to bottom.
  const rowList: Row[] = [
    ...(cloud
      ? [{ y: cloud.y, top: cloud.y - cloudExtent.top, bottom: cloud.y + cloudExtent.bottom }]
      : []),
    ...[
      ...Array.from({ length: topRows }, (_, row) => topY(row)),
      ...Array.from({ length: rows }, (_, row) => middleY(row)),
      ...Array.from({ length: bottomRows }, (_, row) => bottomY(row)),
    ].map((y) => ({ y, top: y - nodeExtent.top, bottom: y + nodeExtent.bottom })),
  ];
  const obstacles = [
    ...placed.map((node) => ({ id: node.id, box: nodeBox(node) })),
    ...(cloud ? [{ id: relayEnd, box: cloudBox(cloud) }] : []),
  ];
  const lanes = new Map<number, number>();
  const wires = map.nodes.flatMap((node) => {
    const wire = node.wire;
    const to = at.get(node.id);
    const hub =
      wire?.from === relayEnd
        ? cloud
          ? { id: relayEnd, ...cloud }
          : undefined
        : at.get(wire?.from ?? "");
    if (!wire || !to || !hub) return [];
    const route = routeWire({
      from: hub,
      to,
      cloud: hub.id === relayEnd,
      rows: rowList,
      obstacles,
      column,
      lanes,
    });
    return [
      {
        node: node.id,
        from: wire.from,
        kind: wire.kind,
        relayed: wire.relayed,
        label: wire.label,
        ...route,
      },
    ];
  });

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
