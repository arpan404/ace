import type { ThreadReader } from "@ace/client";
import { useCallback } from "react";
import { useThread } from "./thread.ts";

export { shallowEqual } from "./shallow-equal.ts";

/*
 * Its own entry (`@ace/client-react/thread-field`), with the shallow comparison a pick of several
 * fields uses: only the views that read single fields load it, so it stays out of the page's
 * first chunk (everything the package index reaches lands there).
 */

/** A thread's own record, as `useThreadMeta` returns it. */
export type ThreadRecord = NonNullable<ThreadReader["thread"]>;

/**
 * One field of a thread, or a value computed from it. The thread gets a new identity on every
 * `thread.updated` and `thread.client.updated` (a tool step sends one), so a view that reads only
 * `workspaceId` or `status` through `useThreadMeta` re-renders on each; through this it
 * re-renders only when its value changes under `equal` (default `Object.is`). Pass a stable
 * `pick` (module scope or useCallback); a new one re-subscribes.
 */
export function useThreadField<T>(
  threadId: string | undefined,
  pick: (thread: ThreadRecord) => T,
  equal?: (a: T | undefined, b: T | undefined) => boolean,
): T | undefined {
  const selector = useCallback(
    (reader: ThreadReader) => (reader.thread ? pick(reader.thread) : undefined),
    [pick],
  );
  return useThread(threadId, ["thread"], selector, equal);
}
