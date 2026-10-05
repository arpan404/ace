import { useToast } from "@/components/ui/toast.tsx";
import { useActivityState } from "./activity-state.tsx";
import { useFeedItems } from "./feed-items.ts";
import { useFeedSource } from "./feed-source.ts";

/** How long Undo is offered, as for archiving or deleting a thread. */
const undoWindowMs = 6_000;

/**
 * Mark every unread item in the current tab and project read, with Undo. Unfiltered, the
 * daemon's cursor moves to now, so older items the feed no longer shows count as read too.
 */
export function useMarkAllRead(): { unread: number; markAll(): void } {
  const { tab, project } = useActivityState();
  const { items } = useFeedItems(tab);
  const source = useFeedSource();
  const toast = useToast();
  const unread = items.filter((item) => !item.read).map((item) => item.id);
  return {
    unread: unread.length,
    markAll() {
      if (!unread.length) return;
      if (tab === "all" && project === undefined) source.markAllRead(Date.now());
      else source.markRead(unread);
      const toastId = toast.add({
        title: `Marked ${unread.length} read`,
        timeout: undoWindowMs,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toast.close(toastId);
            source.markUnread(unread);
          },
        },
      });
    },
  };
}
