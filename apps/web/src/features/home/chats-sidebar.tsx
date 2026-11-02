import { useSidebarLoaded } from "@ace/client-react";
import { ChatsCircleIcon, NotePencilIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { PanelNoMatch, PanelSearch, PanelTitleRow } from "@/components/ui/panel.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useOrganizer, useOverlaidMachineEntries } from "@/features/organize/index.ts";
import { useHeld } from "@/lib/held.ts";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useMachineEntries } from "@/lib/machine-threads.ts";
import { chatChoice } from "@/lib/chat-choice.ts";
import { useMachines } from "@/lib/machines.ts";
import { FoundHits } from "./found-row.tsx";
import { ChatsFilter } from "./chats-filter.tsx";
import { useChatsDevice } from "./device-filter-state.ts";
import { DraftRows } from "./new-thread/draft-rows.tsx";
import { useSettledPaging } from "./settled-paging.ts";
import { ThreadList } from "./thread-list.tsx";
import { useChatList } from "./use-chat-list.ts";
import { useNewChat } from "./use-new-chat.ts";

/**
 * The Chats panel (ADR 0099, ADR 0107), on the canvas beside the rail: its title row ("Chats",
 * New chat), "Search chats", then chats not sent yet, then Active, every unsettled chat (pinned ones first, then what
 * needs the person, then what is at work), then the settled chats under Today, Yesterday,
 * Previous 7 days and Earlier, dimmed.
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
  const newChat = useNewChat();
  const [near, setNear] = useState(false);
  useOlderChats(near, device);
  const searching = query.trim().length > 0;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PanelTitleRow>
        <ChatsFilter />
        <IconButton icon={NotePencilIcon} label="New chat" size="panel" onClick={newChat} />
      </PanelTitleRow>
      <PanelSearch
        label="Search chats"
        placeholder="Search chats"
        value={query}
        onValueChange={setQuery}
      />
      <nav aria-label="Chats" className="flex min-h-0 flex-1 flex-col">
        {/* A chat not sent yet waits on top, as Threads keeps its own drafts. */}
        <div className="hidden shrink-0 px-2 has-[ul]:block">
          <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
            Unsent
          </div>
          <DraftRows project={chatChoice} />
        </div>
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
          <div className="px-2">
            <PanelNoMatch>No chats match.</PanelNoMatch>
          </div>
        ) : (
          <FoundHits value={chats.hits}>
            <ThreadList
              label="Chats"
              rows={chats.rows}
              needsYou={chats.needsYou}
              pinned={chats.pinned}
              onNearEnd={setNear}
            />
          </FoundHits>
        )}
      </nav>
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
