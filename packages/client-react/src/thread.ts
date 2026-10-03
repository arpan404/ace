import { ClientError, type ThreadKey, type ThreadReader, type ThreadStore } from "@ace/client";
import type { Item } from "@ace/protocol";
import { useCallback, useMemo, useRef, useState } from "react";
import { useClient } from "./context.ts";
import { useThreadStore } from "./leases.ts";
import { arrayEqual, useSelection } from "./selection.ts";

/** Select from an already leased thread store; see useThread. */
export function useStoreSelect<T>(
  store: ThreadStore | undefined,
  keys: readonly ThreadKey[],
  selector: (reader: ThreadReader) => T,
  equal?: (a: T, b: T) => boolean,
): T | undefined {
  // Joined keys let callers pass a fresh array literal without re-subscribing.
  const keyList = keys.join("\u0000");
  const stableKeys = useMemo(() => keyList.split("\u0000") as ThreadKey[], [keyList]);
  const selection = useMemo(
    () => store?.select(stableKeys, selector, equal),
    [store, stableKeys, selector, equal],
  );
  return useSelection(selection);
}

/**
 * Select from one thread. The component re-renders only when an event touches one of `keys`
 * and the selected value changes under `equal`. Keys must cover everything the selector reads.
 * Pass a stable selector (module scope or useCallback); a new one re-subscribes.
 */
export function useThread<T>(
  threadId: string | undefined,
  keys: readonly ThreadKey[],
  selector: (reader: ThreadReader) => T,
  equal?: (a: T, b: T) => boolean,
): T | undefined {
  return useStoreSelect(useThreadStore(threadId), keys, selector, equal);
}

const readMeta = (reader: ThreadReader) => reader.thread;
const readOrder = (reader: ThreadReader) => reader.order;
const readError = (reader: ThreadReader) => reader.error;

export function useThreadMeta(threadId: string | undefined) {
  return useThread(threadId, ["thread"], readMeta);
}
export function useThreadError(threadId: string | undefined) {
  return useThread(threadId, ["error"], readError);
}
/** Ids of the loaded transcript window, oldest first. */
export function useItemOrder(threadId: string | undefined): readonly string[] | undefined {
  return useThread(threadId, ["order"], readOrder, arrayEqual);
}
export function useItem(threadId: string | undefined, itemId: string): Item | undefined {
  const selector = useCallback((reader: ThreadReader) => reader.item(itemId), [itemId]);
  return useThread(threadId, [`item:${itemId}`], selector);
}
export function useAgent(threadId: string | undefined, agentId: string) {
  const selector = useCallback((reader: ThreadReader) => reader.agent(agentId), [agentId]);
  return useThread(threadId, [`agent:${agentId}`], selector);
}
export function useTask(threadId: string | undefined, taskId: string) {
  const selector = useCallback((reader: ThreadReader) => reader.task(taskId), [taskId]);
  return useThread(threadId, [`task:${taskId}`], selector);
}
const readTaskIds = (reader: ThreadReader) => reader.taskIds();
export function useTaskIds(threadId: string | undefined) {
  return useThread(threadId, ["tasks"], readTaskIds, arrayEqual);
}

const readBefore = (reader: ThreadReader) => reader.itemsBefore;
export interface HistoryPager {
  /** True while older items exist on the daemon that are not in the loaded window. */
  hasOlder: boolean;
  loading: boolean;
  error: ClientError | undefined;
  loadOlder(): Promise<void>;
}
/** ADR 0006 paging: fetch the page before the window's cursor and merge it into the store. */
export function useHistoryPager(threadId: string | undefined, pageSize = 50): HistoryPager {
  const client = useClient();
  const store = useThreadStore(threadId);
  const before = useStoreSelect(store, ["history"], readBefore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ClientError>();
  const inFlight = useRef(false);
  const loadOlder = useCallback(async () => {
    if (!store || !threadId || inFlight.current) return;
    const cursor = store.itemsBefore;
    if (cursor === null || cursor === undefined) return;
    inFlight.current = true;
    setLoading(true);
    setError(undefined);
    try {
      store.page(await client.itemsPage({ threadId, before: cursor, limit: pageSize }));
    } catch (caught) {
      setError(caught instanceof ClientError ? caught : new ClientError("protocol"));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [client, store, threadId, pageSize]);
  return { hasOlder: typeof before === "number", loading, error, loadOlder };
}
