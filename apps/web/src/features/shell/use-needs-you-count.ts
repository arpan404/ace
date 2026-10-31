import type { SidebarReader } from "@ace/client";
import { useSidebar, type SidebarKey } from "@ace/client-react";

const keys: readonly SidebarKey[] = ["ids", "threads", "unconfirmed"];

/**
 * How many of this machine's threads wait on the person, by the thread list's own rule (a thread
 * whose status is needs-you). A list read back from disk counts none until the daemon confirms
 * it, since its requests may have been answered since. Pure.
 */
export function needsYouCount(reader: SidebarReader): number {
  if (reader.unconfirmed) return 0;
  let count = 0;
  for (const id of reader.ids) if (reader.thread(id)?.status.state === "needs_you") count += 1;
  return count;
}

/** The count for the rail's Threads place; it re-renders only when the number changes. */
export function useNeedsYouCount(): number {
  return useSidebar(keys, needsYouCount) ?? 0;
}
