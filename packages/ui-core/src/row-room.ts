import type { Block } from "./transcript-blocks.ts";

/*
 * The room under each transcript row, shared by the web and native feeds. Three values only:
 * 8 between rows, 16 around a user message or a card, 24 after a finished answer (its actions
 * are laid over that room, so nothing under it moves when they come). Pure.
 */

export type RowRoom = 8 | 16 | 24;

/** Blocks that draw a card or a bubble: they take 16 on both sides. */
const spaced: ReadonlySet<Block["kind"]> = new Set(["user", "files", "started", "question"]);

/** The room a block asks for above and below itself; the larger of two neighbours' wins. */
export function blockRoom(kind: Block["kind"]): { before: RowRoom; after: RowRoom } {
  const room = spaced.has(kind) ? 16 : 8;
  return { before: room, after: kind === "message" ? 24 : room };
}

/** The room under a block of `kind`, given the block after it (none at the end of the feed). */
export function rowRoom(kind: Block["kind"], next?: Block["kind"]): RowRoom {
  const below = blockRoom(kind).after;
  const above = next === undefined ? 8 : blockRoom(next).before;
  return below > above ? below : above;
}
