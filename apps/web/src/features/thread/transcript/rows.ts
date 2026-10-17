import { blockItems, type Block } from "./blocks.ts";

/*
 * The transcript's rows: one per block, each with the root turn it belongs to. Every turn shows
 * whole; the turn rail and ⌥⌘↑/↓ move between turns. Pure over blocks and each item's turn.
 */

export interface Row {
  key: string;
  block: Block;
  /** The block's root turn, where known. */
  ordinal: number | undefined;
}

/** Each item's root turn, where known. */
export type OrdinalOf = (itemId: string) => number | undefined;

function blockOrdinal(block: Block, ordinalOf: OrdinalOf): number | undefined {
  for (const id of blockItems(block)) {
    const ordinal = ordinalOf(id);
    if (ordinal !== undefined) return ordinal;
  }
  return undefined;
}

/**
 * A row's key. The live turn's header is one row whatever block carries it (at the end before
 * its turn's blocks are known, under its ask after), so it moves instead of flashing out and in.
 */
function rowKeyOf(block: Block): string {
  return block.kind === "live" ? "live" : block.key;
}

export function transcriptRows(blocks: readonly Block[], ordinalOf: OrdinalOf): Row[] {
  const rows: Row[] = [];
  let ordinal: number | undefined;
  for (const block of blocks) {
    // A block of no known turn belongs to the turn before it.
    ordinal = blockOrdinal(block, ordinalOf) ?? ordinal;
    rows.push({ key: rowKeyOf(block), block, ordinal });
  }
  return rows;
}

/** Whether two rows draw the same thing: same key, block and turn. */
export function sameRow(a: Row, b: Row): boolean {
  return a === b || (a.key === b.key && a.block === b.block && a.ordinal === b.ordinal);
}

/** The row that shows `itemId`. */
export function rowOf(rows: readonly Row[], itemId: string): number {
  return rows.findIndex((row) => blockItems(row.block).includes(itemId));
}
