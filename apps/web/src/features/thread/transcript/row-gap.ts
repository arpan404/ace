import { rowRoom, type RowRoom } from "@ace/ui-core";
import type { Row } from "./rows.ts";

/* The room under each transcript row: the shared rule (`@ace/ui-core` row-room) as padding. */

const padding: Record<RowRoom, string> = { 8: "pb-2", 16: "pb-4", 24: "pb-6" };

/** The room under `row`, given the row after it (none at the end of the feed). */
export function rowGap(row: Row, next?: Row | undefined): string {
  return padding[rowRoom(row.block.kind, next?.block.kind)];
}
