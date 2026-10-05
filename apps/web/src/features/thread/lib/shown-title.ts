import { usePendingSends } from "@ace/client-react";
import { startedTitle } from "../composer/send-store.ts";

/**
 * The thread's title as the header shows it (UX audit TN-1): the daemon's, except that a thread
 * this window just started reads its provisional title (worked out by New thread as it sent)
 * until the daemon titles it, so nobody sees "New thread" after sending.
 */
export function useShownTitle(threadId: string, title: string | undefined): string | undefined {
  const created = usePendingSends(threadId).find((send) => send.payload.type === "thread.create");
  // The daemon's own name for a thread with no title yet (`untitledThread` in ui-core).
  if (title !== undefined && title !== "New thread") return title;
  return (created && startedTitle(created.commandId)) ?? title;
}
