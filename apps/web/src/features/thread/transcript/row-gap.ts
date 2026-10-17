import type { Block } from "./blocks.ts";
import type { Row } from "./rows.ts";

/* The room under each transcript row, by what it shows. */

const gap: Record<Block["kind"], string> = {
  user: "pb-4",
  // An answer's hover actions (its time, Copy, Fork) are laid over this room, so a finished
  // answer gains no height when they come and nothing under it moves.
  message: "pb-6",
  work: "pb-2.5",
  live: "pb-1.5",
  files: "pb-4",
  subagents: "pb-1.5",
  background: "pb-2",
  item: "pb-3",
  started: "pb-3",
  question: "pb-4",
  event: "pb-3",
  end: "pb-4",
};

export function rowGap(row: Row): string {
  return gap[row.block.kind];
}
