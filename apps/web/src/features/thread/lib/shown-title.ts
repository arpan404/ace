import { usePendingSends } from "@ace/client-react";
import { provisionalTitle, untitledThread } from "@ace/ui-core";

/**
 * The thread's title as the header shows it (UX audit TN-1): the daemon's, except that a thread
 * this window just started reads its provisional title from its first message until the daemon
 * says otherwise, so nobody sees "New thread" after sending.
 */
export function useShownTitle(threadId: string, title: string | undefined): string | undefined {
  const created = usePendingSends(threadId).find((send) => send.payload.type === "thread.create");
  if (title !== undefined && title !== untitledThread) return title;
  return created ? provisionalTitle(created.payload.input) : title;
}
