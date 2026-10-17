import type { ClientError, ThreadKey, ThreadReader, ThreadSource } from "@ace/client";
import type { Item } from "@ace/protocol";
import { useCallback, useMemo } from "react";
import { useThreadStore } from "./leases.ts";
import { arrayEqual, useSelection } from "./selection.ts";

/** Select from an already leased thread store; see useThread. */
export function useStoreSelect<T>(
  store: ThreadSource | undefined,
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
const readSyncing = (reader: ThreadReader) => reader.syncing ?? false;

export function useThreadMeta(threadId: string | undefined): ThreadReader["thread"] | undefined {
  return useThread(threadId, ["thread"], readMeta);
}
export function useThreadError(threadId: string | undefined) {
  return useThread(threadId, ["error"], readError);
}
/** Whether the thread is catching up after a reconnect (`ThreadReader.syncing`). */
export function useThreadSyncing(threadId: string | undefined): boolean {
  return useThread(threadId, ["sync"], readSyncing) ?? false;
}
/** Ids of the loaded transcript window, oldest first. */
export function useItemOrder(threadId: string | undefined): readonly string[] | undefined {
  return useThread(threadId, ["order"], readOrder, arrayEqual);
}
export function useItem(threadId: string | undefined, itemId: string): Item | undefined {
  const selector = useCallback((reader: ThreadReader) => reader.item(itemId), [itemId]);
  return useThread(threadId, [`item:${itemId}`], selector);
}
export function useAgent(
  threadId: string | undefined,
  agentId: string,
): ReturnType<ThreadReader["agent"]> {
  const selector = useCallback((reader: ThreadReader) => reader.agent(agentId), [agentId]);
  return useThread(threadId, [`agent:${agentId}`], selector);
}
export function useTask(
  threadId: string | undefined,
  taskId: string,
): ReturnType<ThreadReader["task"]> {
  const selector = useCallback((reader: ThreadReader) => reader.task(taskId), [taskId]);
  return useThread(threadId, [`task:${taskId}`], selector);
}
const readTaskIds = (reader: ThreadReader) => reader.taskIds();
export function useTaskIds(threadId: string | undefined) {
  return useThread(threadId, ["tasks"], readTaskIds, arrayEqual);
}

/** How a transcript reads older history: through a bounded window beside the live tail (ADR 0062). */
export interface HistoryPager {
  /** True while older items exist on the daemon that are not in the loaded window. */
  hasOlder: boolean;
  loading: boolean;
  error: ClientError | undefined;
  loadOlder(): Promise<void>;
}
