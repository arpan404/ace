import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { useMemo, useState } from "react";

/** A selected value and the entity keys (`item:…`, `run:…`, `agent:…`) it was read from. */
export interface Watched<T> {
  value: T;
  watch: readonly string[];
}

const none: readonly string[] = [];
const sameList = (a: readonly string[], b: readonly string[]) =>
  a === b || (a.length === b.length && a.every((key, index) => key === b[index]));

/**
 * `useThread` whose keys follow what the selector read: `base` plus the entity keys the last
 * reading named, so a selector is re-run when one of those entities changes (a running step's
 * update, a run ending) without subscribing to every item or to streamed text.
 */
export function useWatched<T>(
  threadId: string,
  base: readonly ThreadKey[],
  read: (reader: ThreadReader) => Watched<T>,
  equal: (a: T, b: T) => boolean,
): T | undefined {
  const [watch, setWatch] = useState(none);
  const keys = useMemo(() => [...base, ...(watch as readonly ThreadKey[])], [base, watch]);
  const reading = useThread(
    threadId,
    keys,
    read,
    (a, b) => equal(a.value, b.value) && sameList(a.watch, b.watch),
  );
  const next = reading?.watch ?? none;
  // Derived from the last reading: subscribing to new keys re-reads with them in place.
  if (!sameList(next, watch)) setWatch(next);
  return reading?.value;
}
