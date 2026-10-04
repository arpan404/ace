import type { ThreadKey } from "@ace/client";
import { useTaskIds } from "@ace/client-react";
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
