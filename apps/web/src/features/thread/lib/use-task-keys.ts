import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useTaskIds, useThread } from "@ace/client-react";
import { useMemo } from "react";

/**
 * The keys a selection over the thread's background tasks follows: the list, and each task,
 * since a task's status changes under its own key only.
 */
export function useTaskKeys(threadId: string): ThreadKey[] {
  const ids = useTaskIds(threadId);
  return useMemo<ThreadKey[]>(
    () => ["tasks", ...(ids ?? []).map((id): ThreadKey => `task:${id}`)],
    [ids],
  );
}

const taskItemIds = (reader: ThreadReader) =>
  reader.taskIds().flatMap((id) => {
    const itemId = reader.task(id)?.toolCallId;
    return itemId ? [itemId] : [];
  });

/** Task selections that also read a referenced tool must follow that item's updates. */
export function useTaskItemKeys(threadId: string): ThreadKey[] {
  const keys = useTaskKeys(threadId);
  const itemIds = useThread(threadId, keys, taskItemIds, arrayEqual);
  return useMemo(
    () => [...keys, ...(itemIds ?? []).map((id): ThreadKey => `item:${id}`)],
    [keys, itemIds],
  );
}
