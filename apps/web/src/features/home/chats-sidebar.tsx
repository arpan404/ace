import { useSidebarLoaded } from "@ace/client-react";
import { ChatsCircleIcon, NotePencilIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useOrganizer, useOverlaidMachineEntries } from "@/features/organize/index.ts";
import { useHeld } from "@/lib/held.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useMachineEntries } from "@/lib/machine-threads.ts";
import { useMachines } from "@/lib/machines.ts";
import { ChatHits } from "./chat-row.tsx";
import { ChatsFilter } from "./chats-filter.tsx";
import { useChatsDevice } from "./device-filter-state.ts";
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
 * with a chat's hover actions. Other machines' chats join the list (ADR 0102), each acting on
 * its own machine; with more than one device the title is a device filter of the panel's own.
 * Older chats page in from the daemon as the list nears its end.
 */
export function ChatsSidebar() {
  const [query, setQuery] = useState("");
  const host = useHostIdentity()?.hostId;
  const others = useOverlaidMachineEntries(useMachineEntries(host));
  const device = useChatsDevice();
  const deviceName = useMachines().find((machine) => machine.id === device)?.name;
  const organizer = useOrganizer();
  const chats = useChatList(query, others, device);
  const loaded = useSidebarLoaded();
  const skeleton = useHeld(!loaded);
  const home = useHomeList(others);
  const bell = useRef<HTMLButtonElement>(null);
  const inbox = useInboxStore();
  const inboxOpen = useInboxOpen();
  const newChat = useNewChat();
  const [near, setNear] = useState(false);
  useOlderChats(near, device);
  const searching = query.trim().length > 0;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-slot="panel-top"
        className="flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-2"
      >
        <ChatsFilter />
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
            title={deviceName ? `No chats on ${deviceName}` : "No chats yet"}
            description={
              deviceName
                ? "Chats on this device will land here."
                : "A chat needs no project. Ask anything."
            }
            action={
              <button
                type="button"
                className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                onClick={deviceName ? () => organizer.setChatDevice(undefined) : newChat}
              >
                {deviceName ? "Show all devices" : "New chat"}
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
 * end stays in view, and the list keeps only the chats among them. Only this machine's daemon
 * pages: another machine's chats all arrive at once, so with one chosen nothing is asked.
 */
function useOlderChats(near: boolean, device: string | undefined): void {
  const paging = useSettledPaging(null, device);
  const ask = near && paging.hasMore && !paging.loading && !paging.error;
  const { more, nextAt } = paging;
  useEffect(() => {
    if (ask) void more();
    // `nextAt` moves with each page: while the end stays in view, the next one is asked for.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, nextAt]);
}
