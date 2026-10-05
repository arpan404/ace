import { blockItems, type Block } from "./blocks.ts";

/*
 * The transcript's rows: blocks grouped by the root turn they belong to. Older turns fold into
 * one digest row each, so a window of a long thread reads as a list of turns with the recent
 * ones (and any the reader opened) shown whole. An opened older turn gets a slim header that
 * folds it again. Pure over blocks and each item's turn.
 */

export type Row =
  | { kind: "block"; key: string; block: Block; ordinal: number | undefined }
  | {
      kind: "turn";
      key: string;
      ordinal: number;
      /** The person's message that started the turn, when it is in view. */
      askId: string | undefined;
      /** Every item folded into the row, so a jump into the turn can find it. */
      itemIds: readonly string[];
    }
  | { kind: "head"; key: string; ordinal: number };

export interface RowOptions {
  /** Each item's root turn, where known. Items of unknown turns never fold. */
  ordinalOf(itemId: string): number | undefined;
  /** Turns shown whole whatever their age (the reader opened them, a jump aimed at one). */
  open: ReadonlySet<number>;
  /** Turns at or after this ordinal are recent and shown whole without a header. */
  openFrom: number;
  /**
   * Blocks that keep their turn whole whatever its age: a request still waiting on the person,
   * a step still in flight. Never folded away, so never hidden.
   */
  keep?(block: Block): boolean;
}

/**
 * Older turns fold only once the loaded window is long: more than 12 turns or 400 items. Then
 * the 5 newest stay whole.
 */
export const foldRule = { turns: 12, items: 400, keep: 5 } as const;

/** The first turn shown whole in the live transcript: every turn, until the window is long. */
export function recentFrom(latest: number | undefined, turns: number, items: number): number {
  if (latest === undefined || (turns <= foldRule.turns && items <= foldRule.items))
    return Number.NEGATIVE_INFINITY;
  return latest - foldRule.keep + 1;
}

/** How many turns the blocks hold. */
export function turnCount(blocks: readonly Block[], ordinalOf: RowOptions["ordinalOf"]): number {
  const turns = new Set<number>();
  for (const block of blocks) {
    const ordinal = blockOrdinal(block, ordinalOf);
    if (ordinal !== undefined) turns.add(ordinal);
  }
  return turns.size;
}

function blockOrdinal(block: Block, ordinalOf: RowOptions["ordinalOf"]): number | undefined {
  for (const id of blockItems(block)) {
    const ordinal = ordinalOf(id);
    if (ordinal !== undefined) return ordinal;
  }
  return undefined;
}

export function transcriptRows(blocks: readonly Block[], options: RowOptions): Row[] {
  const rows: Row[] = [];
  let index = 0;
  while (index < blocks.length) {
    const first = blocks[index];
    if (!first) break;
    const ordinal = blockOrdinal(first, options.ordinalOf);
    // The section: this block and the following ones of the same turn (unknown ones join it).
    let end = index + 1;
    while (end < blocks.length) {
      const next = blocks[end];
      const nextOrdinal = next ? blockOrdinal(next, options.ordinalOf) : undefined;
      if (nextOrdinal !== undefined && nextOrdinal !== ordinal) break;
      end++;
    }
    const section = blocks.slice(index, end);
    index = end;
    if (
      ordinal === undefined ||
      ordinal >= options.openFrom ||
      (options.keep && section.some(options.keep))
    ) {
      for (const block of section) rows.push({ kind: "block", key: block.key, block, ordinal });
      continue;
    }
    if (options.open.has(ordinal)) {
      rows.push({ kind: "head", key: `head:${first.key}`, ordinal });
      for (const block of section) rows.push({ kind: "block", key: block.key, block, ordinal });
      continue;
    }
    const ask = section.find((block) => block.kind === "user");
    rows.push({
      kind: "turn",
      key: `turn:${first.key}`,
      ordinal,
      askId: ask?.kind === "user" ? ask.itemId : undefined,
      itemIds: section.flatMap((block) => blockItems(block)),
    });
  }
  return rows;
}

/** The newest turn among the blocks, for which turns count as recent. */
export function newestOrdinal(
  blocks: readonly Block[],
  ordinalOf: RowOptions["ordinalOf"],
): number | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    const ordinal = block ? blockOrdinal(block, ordinalOf) : undefined;
    if (ordinal !== undefined) return ordinal;
  }
  return undefined;
}

/** The row that shows `itemId`, folded or not. */
export function rowOf(rows: readonly Row[], itemId: string): number {
  return rows.findIndex((row) =>
    row.kind === "turn"
      ? row.itemIds.includes(itemId)
      : row.kind === "block" && blockItems(row.block).includes(itemId),
  );
}
