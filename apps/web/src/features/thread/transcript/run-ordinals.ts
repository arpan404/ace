import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { itemTurnOrdinals } from "@ace/ui-core";

/** Each loaded item's root turn from its run, rebuilt only when items arrive or agents link. */
function readOrdinals(reader: ThreadReader): ReadonlyMap<string, number> {
  const ordinals = itemTurnOrdinals(reader);
  const map = new Map<string, number>();
  reader.order.forEach((id, index) => {
    const ordinal = ordinals[index];
    if (ordinal !== undefined) map.set(id, ordinal);
  });
  return map;
}
function sameOrdinals(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, ordinal] of a) if (b.get(id) !== ordinal) return false;
  return true;
}
/** Each shown item's turn, read inside the window provider (so from the window when jumped). */
export function useRunOrdinals(threadId: string): ReadonlyMap<string, number> {
  return useThread(threadId, ["order", "agents"], readOrdinals, sameOrdinals) ?? emptyOrdinals;
}
const emptyOrdinals: ReadonlyMap<string, number> = new Map();
