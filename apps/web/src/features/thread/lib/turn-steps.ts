import type { ClientApi } from "@ace/client";
import { TurnStepsCache, type TurnStepsEntry } from "@ace/client/turn-steps";
import { useClient } from "@ace/client-react";
import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import {
  KeptTurnStepsConnection,
  keptTurnSteps,
  type KeptConnection,
} from "@/boot/kept-turn-steps.ts";

/*
 * A finished turn's steps, read from the daemon (`turn.steps`) when its "Worked for" log opens
 * or the pointer reaches it. What was read stays in memory, within the cache's budget, through
 * closing and reopening the log or its thread, and (on a real daemon's connection) is kept with
 * the connection's read snapshots so a later session shows it at once. One cache per client.
 */

interface Held {
  connection: KeptConnection | undefined;
  cache: TurnStepsCache;
}

const caches = new WeakMap<ClientApi, Held>();

const sameConnection = (a: KeptConnection | undefined, b: KeptConnection | undefined) =>
  a?.target === b?.target && a?.hostId === b?.hostId;

function useCache(): TurnStepsCache {
  const client = useClient();
  const connection = useContext(KeptTurnStepsConnection);
  const held = caches.get(client);
  if (held && sameConnection(held.connection, connection)) return held.cache;
  const cache = new TurnStepsCache({
    read: (input, options) => client.request(input, options),
    store: connection ? keptTurnSteps(connection) : undefined,
  });
  caches.set(client, { connection, cache });
  return cache;
}

export interface TurnSteps {
  entry: TurnStepsEntry | undefined;
  /** Read again after a failed read. */
  retry(): void;
  /** Read the next part of a turn longer than one read. */
  loadMore(): void;
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
): TurnSteps {
  const cache = useCache();
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
  return {
    entry,
    // Holding a failed turn once more reads it again; the open log's own hold stays.
    retry: () => {
      if (ordinal !== undefined) cache.retain(threadId, ordinal, endSeq)();
    },
    loadMore: () => {
      if (ordinal !== undefined) cache.loadMore(threadId, ordinal);
    },
  };
}

/**
 * Reads a finished turn that is about to open (the pointer over its "Worked for", focus on it),
 * so it opens on its steps. Undefined for a turn the daemon can't name.
 */
export function useWarmTurnSteps(
  threadId: string,
  ordinal: number | undefined,
  endSeq: number | undefined,
): (() => void) | undefined {
  const cache = useCache();
  if (ordinal === undefined) return undefined;
  return () => cache.warm(threadId, ordinal, endSeq);
}

/** Ends the thread's holds and reads in flight once its view closes; what was read stays. */
export function useDropTurnSteps(threadId: string): void {
  const cache = useCache();
  useEffect(() => () => cache.dropThread(threadId), [cache, threadId]);
}
