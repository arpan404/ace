import { usePendingSends } from "@ace/client-react";
import { roleTitle } from "@ace/ui-core/thread-title";
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

/**
 * A delegated child still titled with its role slug ("Clean-iOS-settings", from before the daemon
 * wrote it as words) reads as words; any title with spaces in it is the person's or the model's
 * own and stays as it is.
 */
export function delegatedTitle(delegated: boolean, title: string | undefined): string | undefined {
  return delegated && title !== undefined && !/\s/.test(title) && /[-_]/.test(title)
    ? roleTitle(title)
    : title;
}
