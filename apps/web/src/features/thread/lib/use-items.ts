import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { useCallback, useMemo } from "react";

/**
 * Select one value from several items. Re-renders only when one of those items changes and the
 * selected value differs under `equal`. Pass a stable `select` (module scope or useCallback).
 */
export function useItemsSelect<T>(
  threadId: string,
  ids: readonly string[],
  select: (items: readonly (Item | undefined)[]) => T,
  equal?: (a: T, b: T) => boolean,
): T | undefined {
  const keys = useMemo(() => ids.map((id): ThreadKey => `item:${id}`), [ids]);
  const selector = useCallback(
    (reader: ThreadReader) => select(ids.map((id) => reader.item(id))),
    [ids, select],
  );
  return useThread(threadId, keys, selector, equal);
}

/** Equality for small flat records of primitives. */
export function flatEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}
