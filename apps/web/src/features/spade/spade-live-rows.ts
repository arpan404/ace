import type { SpadeLiveAgent, SpadeLiveGroup } from "@ace/ui-core/spade-chat";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

/*
 * What each conversation open in this window says of its bot's or group's state, from the same
 * live view its chat draws (`spadeLiveAgent`, `spadeLiveGroup`). The roster and the groups list
 * lay it over what they last read, so a row and its open chat never disagree; the rest of the
 * list is read every few seconds as before.
 */

export interface SpadeLiveRows {
  /** By `machine key/conversation id`. */
  bots: ReadonlyMap<string, SpadeLiveAgent>;
  groups: ReadonlyMap<string, SpadeLiveGroup>;
}

/** A conversation's key across machines: ids repeat between machines' Spades. */
export const liveRowKey = (machineKey: string, conversation: string) =>
  `${machineKey}/${conversation}`;

/** `map` with `key` set to `value` (gone when undefined); undefined when nothing changed. */
function withKey<V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined) {
  if (value === undefined && !map.has(key)) return undefined;
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

class LiveRowsStore {
  private rows: SpadeLiveRows = { bots: new Map(), groups: new Map() };
  private listeners = new Set<() => void>();

  get = (): SpadeLiveRows => this.rows;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setBot(key: string, live: SpadeLiveAgent | undefined) {
    const bots = withKey(this.rows.bots, key, live);
    if (bots) this.change({ ...this.rows, bots });
  }

  setGroup(key: string, live: SpadeLiveGroup | undefined) {
    const groups = withKey(this.rows.groups, key, live);
    if (groups) this.change({ ...this.rows, groups });
  }

  private change(rows: SpadeLiveRows) {
    this.rows = rows;
    for (const listener of this.listeners) listener();
  }
}

/** One store per window: its query cache is the window's. */
const stores = new WeakMap<QueryClient, LiveRowsStore>();
function storeOf(cache: QueryClient): LiveRowsStore {
  let store = stores.get(cache);
  if (!store) {
    store = new LiveRowsStore();
    stores.set(cache, store);
  }
  return store;
}

/** What the conversations open in this window say of their rows. */
export function useLiveRows(): SpadeLiveRows {
  const store = storeOf(useQueryClient());
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** An open bot conversation's row (`key` from `liveRowKey`), while it is open. */
export function usePublishLiveBot(
  key: string,
  live: SpadeLiveAgent | undefined,
  listKey: readonly unknown[],
) {
  const state = live?.kind === "known" ? live.state : live?.kind;
  usePublish(key, live, state, listKey, (store, value) => store.setBot(key, value));
}

/** An open group conversation's row (`key` from `liveRowKey`), while it is open. */
export function usePublishLiveGroup(
  key: string,
  live: SpadeLiveGroup | undefined,
  listKey: readonly unknown[],
) {
  usePublish(key, live, live?.state, listKey, (store, value) => store.setGroup(key, value));
}

/**
 * Publishes `live` while the conversation is open, and takes it back when it closes. When its
 * `state` changes, its list (`listKey`) is read again at once, so the rest of the row (its last
 * message, its unseen mark) follows without waiting for the next read.
 */
function usePublish<V>(
  key: string,
  live: V | undefined,
  state: string | undefined,
  listKey: readonly unknown[],
  put: (store: LiveRowsStore, live: V | undefined) => void,
) {
  const cache = useQueryClient();
  const store = storeOf(cache);
  // A stable word for `live`, so a view that changed elsewhere doesn't publish again.
  const word = live === undefined ? "" : JSON.stringify(live);
  useEffect(() => {
    put(store, live);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `word` stands for `live`
  }, [store, key, word]);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `put` follows `key`
  useEffect(() => () => put(store, undefined), [store, key]);
  const listed = JSON.stringify(listKey);
  useEffect(() => {
    if (state === undefined) return;
    void cache.invalidateQueries({ queryKey: listKey });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `listed` stands for `listKey`
  }, [cache, state, listed]);
}
