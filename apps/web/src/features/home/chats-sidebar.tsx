import { useSidebarLoaded } from "@ace/client-react";
import { ChatsCircleIcon, NotePencilIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useHeld } from "@/lib/held.ts";
import { ChatHits } from "./chat-row.tsx";
import { InboxBell } from "./inbox-bell.tsx";
import { InboxOverlay } from "./inbox-overlay.tsx";
import { panelIconButton } from "./panel-icon-button.ts";
import { useSettledPaging } from "./settled-paging.ts";
import { ThreadList } from "./thread-list.tsx";
import { useChatList } from "./use-chat-list.ts";
import { useHomeList } from "./use-home-threads.ts";
import { useInboxOpen, useInboxStore } from "./use-inbox-open.ts";
import { useNewChat } from "./use-new-chat.ts";

/**
 * The Chats panel (ADR 0099, ADR 0107), on the canvas beside the rail: its title row ("Chats",
 * the Inbox bell, New chat), "Search chats", then every chat in one flat list: Pinned first, the
 * rest under Today, Yesterday, Previous 7 days and Earlier, settled ones dimmed in their day.
 * The rows are the Threads list's own (one line, one mark, the hover card, keyboard and motion),
 * with a chat's hover actions. Older chats page in from the daemon as the list nears its end.
 */
export function ChatsSidebar() {
  const [query, setQuery] = useState("");
  const chats = useChatList(query);
  const loaded = useSidebarLoaded();
  const skeleton = useHeld(!loaded);
  const home = useHomeList();
  const bell = useRef<HTMLButtonElement>(null);
  const inbox = useInboxStore();
  const inboxOpen = useInboxOpen();
  const newChat = useNewChat();
  const [near, setNear] = useState(false);
  useOlderChats(near);
  const searching = query.trim().length > 0;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-slot="panel-top"
        className="flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-4"
      >
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-title text-foreground">
          Chats
        </h2>
        <InboxBell ids={home.inbox} bell={bell} />
        <Tip label="New chat">
          <button type="button" aria-label="New chat" onClick={newChat} className={panelIconButton}>
            <Icon icon={NotePencilIcon} size={18} />
          </button>
        </Tip>
      </div>
      <div className="shrink-0 px-2 pb-1">
        <SearchField
          label="Search chats"
          placeholder="Search chats"
          value={query}
          onValueChange={setQuery}
        />
      </div>
      <nav aria-label="Chats" className="flex min-h-0 flex-1 flex-col">
        {!loaded ? (
          skeleton && <ListSkeleton label="chats" shape="thread" />
        ) : !chats.any ? (
          <EmptyState
            className="shrink-0 justify-start pt-6"
            icon={ChatsCircleIcon}
            title="No chats yet"
            description="A chat needs no project. Ask anything."
            action={
              <button
                type="button"
                className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                onClick={newChat}
              >
                New chat
              </button>
            }
          />
        ) : searching && !chats.rows.length ? (
          <p className="px-4 pt-4 text-ui text-subtle-foreground">No chats match.</p>
        ) : (
          <ChatHits value={chats.hits}>
            <ThreadList
              label="Chats"
              rows={chats.rows}
              needsYou={chats.needsYou}
              pinned={chats.pinned}
              onNearEnd={setNear}
            />
          </ChatHits>
        )}
      </nav>
      {inboxOpen && <InboxOverlay ids={home.inbox} bell={bell} onClose={() => inbox.set(false)} />}
    </div>
  );
}

/**
 * Older chats from the daemon while the list's end is in view (`near`). The daemon pages every
 * settled thread together, newest first, and can't page chats alone: pages keep coming while the
 * end stays in view, and the list keeps only the chats among them.
 */
function useOlderChats(near: boolean): void {
  const paging = useSettledPaging(null);
  const ask = near && paging.hasMore && !paging.loading && !paging.error;
  const { more, nextAt } = paging;
  useEffect(() => {
    if (ask) void more();
    // `nextAt` moves with each page: while the end stays in view, the next one is asked for.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, nextAt]);
}
