import { useSidebarLoaded } from "@ace/client-react";
import { homeRowThread } from "@ace/ui-core";
import { ChatsCircleIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useChatList } from "./use-chat-list.ts";
import { useNewChat } from "./use-new-chat.ts";

/**
 * `/chats`: the Chats place never rests on an empty pane. It opens the top chat of the panel's
 * list; with none yet, it says so, with New chat.
 */
export function ChatsEmptyScreen() {
  const loaded = useSidebarLoaded();
  const chats = useChatList("");
  const newChat = useNewChat();
  const top = chats.rows.map(homeRowThread).find((id) => id !== undefined);
  if (top) return <Navigate to="/t/$threadId" params={{ threadId: top }} replace />;
  if (!loaded)
    return (
      <Screen title="Chats">
        <LoadingRegion
          label="Chats"
          className="flex h-full flex-col items-center justify-center gap-2 px-5 py-6"
        >
          <Skeleton className="h-3.5 w-28" />
        </LoadingRegion>
      </Screen>
    );
  return (
    <Screen title="Chats">
      <EmptyState
        icon={ChatsCircleIcon}
        heading
        title="No chats yet"
        description="A chat needs no project. Ask anything."
        action={
          <button
            type="button"
            className="rounded-sm text-ui font-medium text-foreground underline-offset-4 focus-ring hover:underline"
            onClick={newChat}
          >
            New chat
          </button>
        }
      />
    </Screen>
  );
}
