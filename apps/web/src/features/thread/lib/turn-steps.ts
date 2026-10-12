import type { ClientApi } from "@ace/client";
import { TurnStepsCache, type TurnStepsEntry } from "@ace/client/turn-steps";
import { useClient } from "@ace/client-react";
import { useCallback, useEffect, useSyncExternalStore } from "react";

/*
 * A finished turn's steps, read from the daemon (`turn.steps`) only while its "Worked for" log
 * is open, and dropped soon after it closes, scrolls far away or its thread closes: a long
 * thread never keeps every finished step in memory. One bounded cache per daemon client.
 */

const caches = new WeakMap<ClientApi, TurnStepsCache>();

function cacheOf(client: ClientApi): TurnStepsCache {
  let cache = caches.get(client);
  if (!cache) {
    cache = new TurnStepsCache({ read: (input, options) => client.request(input, options) });
    caches.set(client, cache);
  }
  return cache;
}

/**
 * The turn's steps while `open`. `endSeq` is the turn's end from its summary, when known: a
 * read older than it is read again.
 */
export function useTurnSteps(
  threadId: string,
  ordinal: number | undefined,
  open: boolean,
  endSeq?: number,
): TurnStepsEntry | undefined {
  const cache = cacheOf(useClient());
  const read = useCallback(
    () => (ordinal === undefined ? undefined : cache.get(threadId, ordinal)),
    [cache, threadId, ordinal],
  );
  const entry = useSyncExternalStore(
    useCallback((listener) => cache.subscribe(listener), [cache]),
    read,
    read,
  );
  useEffect(() => {
    if (!open || ordinal === undefined) return;
    return cache.retain(threadId, ordinal, endSeq);
  }, [cache, threadId, ordinal, open, endSeq]);
  return entry;
}

/** Drops the thread's finished steps once its view closes. */
export function useDropTurnSteps(threadId: string): void {
  const cache = cacheOf(useClient());
  useEffect(() => () => cache.dropThread(threadId), [cache, threadId]);
}
