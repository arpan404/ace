import type { ThreadKey, ThreadReader } from "@ace/client";
import { useItem, useThread } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { createContext, use, useCallback, useMemo } from "react";

/*
 * Where a work log's rows read their items: the live thread first, then the steps a finished
 * turn's log read from the daemon when it opened (`turn.steps`), which the thread's window may
 * no longer hold.
 */

export const StepItems = createContext<ReadonlyMap<string, Item> | undefined>(undefined);

/** One step's item, live or read for its finished log. */
export function useStepItem(threadId: string, itemId: string): Item | undefined {
  const fetched = use(StepItems);
  return useItem(threadId, itemId) ?? fetched?.get(itemId);
}

/** `useItemsSelect` over live items, falling back to the ones a finished log read. */
export function useStepItemsSelect<T>(
  threadId: string,
  ids: readonly string[],
  select: (items: readonly (Item | undefined)[]) => T,
  equal?: (a: T, b: T) => boolean,
): T | undefined {
  const fetched = use(StepItems);
  const keys = useMemo(() => ids.map((id): ThreadKey => `item:${id}`), [ids]);
  const selector = useCallback(
    (reader: ThreadReader) => select(ids.map((id) => reader.item(id) ?? fetched?.get(id))),
    [ids, select, fetched],
  );
  return useThread(threadId, keys, selector, equal);
}
