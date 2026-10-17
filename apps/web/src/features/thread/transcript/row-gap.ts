import type { Block } from "./blocks.ts";
import type { Row } from "./rows.ts";

/* The room under each transcript row, by what it shows and what follows it. */

const gap: Record<Block["kind"], string> = {
  user: "pb-4",
  message: "pb-4",
  work: "pb-2.5",
  live: "pb-1.5",
  thinking: "pb-2",
  files: "pb-4",
  subagents: "pb-1.5",
  background: "pb-2",
  item: "pb-3",
  started: "pb-3",
  question: "pb-4",
  event: "pb-3",
  end: "pb-4",
};
/**
 * A progress note followed straight by another sits close to it; a turn's last answer doesn't.
 * An answer under its turn's "Worked for" keeps its time in its hover-actions row, so its
 * changed files sit close.
 */
export function rowGap(row: Row, next: Row | undefined): string {
  if (row.block.kind === "message" && next?.block.kind === "message") return "pb-1.5";
  if (row.block.kind === "message" && row.block.headed && next?.block.kind === "files")
    return "pb-1.5";
  return gap[row.block.kind];
}
