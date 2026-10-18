import type { Block } from "./blocks.ts";
import type { Row } from "./rows.ts";

/*
 * The room under each transcript row. Three values only: 8px between rows, 16px around a user
 * message or a card, 24px after a finished answer (its hover actions, time, Copy and Fork, are
 * laid over that room, so a finished answer gains no height when they come and nothing under it
 * moves).
 */

type Room = 8 | 16 | 24;

/** Blocks that draw a card or a bubble: they take 16px on both sides. */
const spaced = new Set<Block["kind"]>(["user", "files", "started", "question"]);

function after(block: Block): Room {
  if (block.kind === "message") return 24;
  return spaced.has(block.kind) ? 16 : 8;
}

function before(block: Block): Room {
  return spaced.has(block.kind) ? 16 : 8;
}

const padding: Record<Room, string> = { 8: "pb-2", 16: "pb-4", 24: "pb-6" };

/** The room under `row`, given the row after it (none at the end of the feed). */
export function rowGap(row: Row, next?: Row | undefined): string {
  const room = Math.max(after(row.block), next ? before(next.block) : 8) as Room;
  return padding[room];
}
