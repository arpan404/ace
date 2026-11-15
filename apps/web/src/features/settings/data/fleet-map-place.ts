import { relayEnd, type FleetMap, type MapNode, type ZoneId } from "@ace/ui-core/fleet-map";

/*
 * Which grid cell each Fleet map node takes, by how it reaches this computer. Pure.
 *
 * - Top band, under the relay cloud: whatever is reached through the relay, alternately left and
 *   right of the middle column, which stays free for this computer's own wire.
 * - Middle band: this computer in column 0 with whatever it reaches over its own networks. Each
 *   network's members are grouped so the network's zone can be drawn around them: the local
 *   network to the left, the tailnet to the right, both in the overlap. Its own group fills the
 *   cells beside and diagonally under it first, so those wires run straight.
 * - Bottom band: whatever doesn't reach it (offline, refused, waiting) or reaches it through
 *   another machine, near the column of the end it hangs from, outside every zone.
 *
 * Column 0 under this computer stays empty in every row: it's the trunk wires run down.
 */

export type Band = "top" | "middle" | "bottom";
export interface Cell {
  band: Band;
  col: number;
  /** Its row within its band. */
  row: number;
}

const perRow = 3;
type ZoneKey = "lan" | "tailnet" | "both" | "none";

const zoneKey = (zones: readonly ZoneId[]): ZoneKey =>
  zones.includes("lan")
    ? zones.includes("tailnet")
      ? "both"
      : "lan"
    : zones.includes("tailnet")
      ? "tailnet"
      : "none";

function groupOf(node: MapNode, own: string, ownKey: ZoneKey): string {
  if (node.id === own) return "own";
  const wire = node.wire;
  if (wire?.from === relayEnd) return "top";
  if (wire?.from !== own) return "bottom";
  const key = zoneKey(node.zones);
  if (key !== "none") {
    if (key === ownKey) return "own";
    return key === "both" ? "tailnet" : key;
  }
  return wire.kind === "direct" ? "other" : "bottom";
}

/** Beside this computer first, then the row under, then the rest of the first row, then on. */
const rank = (cell: { col: number; row: number }) =>
  cell.row === 0 && Math.abs(cell.col) === 1
    ? 0
    : cell.row === 1
      ? 1
      : cell.row === 0
        ? 2
        : cell.row + 1;

/**
 * A group's cells from column `first` outward: the cell beside this computer first, then the row
 * diagonally under the band's first row, then the rest of the first row, then further rows. Wires
 * to the cell beside it and to the row under it run straight.
 */
function groupCells(count: number, first: number, dir: 1 | -1): { col: number; row: number }[] {
  if (count === 0) return [];
  const beside = Math.abs(first) === 1;
  const rows = count === 1 && beside ? 1 : Math.max(2, Math.ceil(count / perRow));
  const cols = Math.ceil(count / rows);
  const cells = Array.from({ length: rows * cols }, (_, index) => ({
    col: first + dir * (index % cols),
    row: Math.floor(index / cols),
  }));
  return cells
    .toSorted((a, b) => rank(a) - rank(b) || Math.abs(a.col) - Math.abs(b.col))
    .slice(0, count);
}

export function placeNodes(map: FleetMap, own: string): Map<string, Cell> {
  const ownNode = map.nodes.find((node) => node.id === own);
  const ownKey = zoneKey(ownNode?.zones ?? []);
  const groups = new Map<string, MapNode[]>();
  for (const node of map.nodes) {
    const group = groupOf(node, own, ownKey);
    if (group === "own" && node.id === own) continue;
    groups.set(group, [...(groups.get(group) ?? []), node]);
  }
  const of = (group: string) => groups.get(group) ?? [];
  const cells = new Map<string, Cell>();

  of("top").forEach((node, index) => {
    const nth = Math.floor(index / 2);
    cells.set(node.id, {
      band: "top",
      col: (index % 2 === 0 ? -1 : 1) * (1 + (nth % perRow)),
      row: Math.floor(nth / perRow),
    });
  });

  cells.set(own, { band: "middle", col: 0, row: 0 });
  // Its devices first: they sit nearest, on short straight wires.
  const mine = [
    ...of("own").filter((node) => node.role === "device"),
    ...of("own").filter((node) => node.role !== "device"),
  ];
  const ownDir = ownKey === "lan" ? -1 : 1;
  groupCells(mine.length, ownDir, ownDir).forEach((cell, index) => {
    const node = mine[index];
    if (node) cells.set(node.id, { band: "middle", ...cell });
  });
  const reach = (dir: 1 | -1) =>
    Math.max(
      0,
      ...[...cells.values()].filter((cell) => cell.band === "middle").map((cell) => cell.col * dir),
    );
  const place = (group: string, dir: 1 | -1) =>
    groupCells(of(group).length, dir * (reach(dir) + 1), dir).forEach((cell, index) => {
      const node = of(group)[index];
      if (node) cells.set(node.id, { band: "middle", ...cell });
    });
  if (ownKey !== "lan") place("lan", -1);
  if (ownKey !== "tailnet") place("tailnet", 1);
  place("other", 1);

  // The bottom band: near the column of what each hangs from, below it when that's here too.
  const taken = new Set<string>();
  for (const node of of("bottom")) {
    const hub = cells.get(node.wire?.from ?? "");
    const want = hub && hub.col !== 0 ? hub.col : 1;
    const first = hub?.band === "bottom" ? hub.row + 1 : 0;
    for (let row = first, placed = false; !placed; row += 1)
      for (let step = 0; step <= perRow * 2 && !placed; step += 1)
        for (const col of step === 0 ? [want] : [want + step, want - step]) {
          if (col === 0 || taken.has(`${col}:${row}`)) continue;
          taken.add(`${col}:${row}`);
          cells.set(node.id, { band: "bottom", col, row });
          placed = true;
          break;
        }
  }
  return cells;
}
