import { ChatsCircleIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";

/*
 * Tools the workspace lists but the daemon can't serve yet. Each says exactly what is missing
 * and offers what does work, instead of looking broken. The Side chat tool replaces
 * this by registering a kind with the same id.
 */

/** Side chat: a temporary conversation beside the thread needs a daemon API for one. */
export function SideChatPlaceholder() {
  return (
    <EmptyState
      icon={ChatsCircleIcon}
      title="Side chats aren't available yet"
      description="A side chat is a short, temporary conversation about this thread that never changes its work. The daemon has no way to run one yet; ask in the thread's composer meanwhile."
    />
  );
}
