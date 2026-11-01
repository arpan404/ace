import type { SidebarReader } from "@ace/client";
import { useSidebar } from "@ace/client-react";
import { BellIcon } from "@phosphor-icons/react";
import { useCallback, type RefObject } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { panelIconButton } from "./panel-icon-button.ts";
import { useInboxOpen, useInboxStore } from "./use-inbox-open.ts";

/**
 * The Inbox bell, in the Threads and Chats panels' title rows: it (or ⌘I) opens the Inbox over
 * the list. Its dot asks loudest for what the Inbox holds: the warning colour while anything
 * needs the person, the blue while it holds only results not yet seen.
 */
export function InboxBell({
  ids,
  bell,
}: {
  /** What the Inbox holds now (`HomeList.inbox`). */
  ids: readonly string[];
  bell: RefObject<HTMLButtonElement | null>;
}) {
  const inbox = useInboxStore();
  const open = useInboxOpen();
  const waiting = ids.length;
  const asks = useCallback(
    (reader: SidebarReader) => ids.some((id) => reader.thread(id)?.status.state === "needs_you"),
    [ids],
  );
  const needsYou = useSidebar(["ids", "threads"], asks) ?? false;
  return (
    <Tip label="Inbox" shortcut="inbox">
      <button
        ref={bell}
        type="button"
        aria-label={waiting ? `Inbox, ${waiting} waiting` : "Inbox"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={inbox.toggle}
        className={cn(panelIconButton, open && "bg-active text-foreground")}
      >
        <Icon icon={BellIcon} size={18} />
        {waiting > 0 && (
          <span
            aria-hidden
            data-inbox-dot=""
            data-tone={needsYou ? "needs-you" : "unread"}
            className="absolute top-1.5 right-1.5 size-2 rounded-full bg-(--tone) ring-2 ring-sidebar"
          />
        )}
      </button>
    </Tip>
  );
}
