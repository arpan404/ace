import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { createContext, use } from "react";
import { cn } from "@/lib/cn.ts";
import { panelRowLine } from "@/components/ui/panel.tsx";
import { ChatRowActions } from "./chat-row-actions.tsx";
import { ThreadRow, useOpenHere } from "./thread-row.tsx";
import type { SearchHit } from "./use-panel-search.ts";

/** The Chats search's hits for older chats the list hasn't loaded, by thread id. */
export const ChatHits = createContext<ReadonlyMap<string, SearchHit>>(new Map());

/**
 * A chat in the Chats panel: a thread row (one line led by its provider's mark, its one mark,
 * the hover card) with a chat's
 * hover actions, dimmed while settled. An older chat only the search found draws from its hit.
 */
export function ChatRow(props: { id: string; settled: boolean; leaving: boolean }) {
  const listed = useSidebarThread(props.id) !== undefined;
  const hit = use(ChatHits).get(props.id);
  if (!listed && hit) return <FoundChatRow hit={hit} />;
  return (
    <ThreadRow
      threadId={props.id}
      settled={false}
      leaving={props.leaving}
      lead="provider"
      actions={ChatRowActions}
      compactActions
      dimmed={props.settled}
    />
  );
}

/** A chat the daemon's search found that the list hasn't paged in: its title, dimmed. */
function FoundChatRow(props: { hit: SearchHit }) {
  const { hit } = props;
  const current = useOpenHere(hit.threadId, undefined);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: hit.threadId }}
      aria-label={`${hit.threadTitle}. Settled`}
      data-row-focus=""
      draggable={false}
      className={cn(
        panelRowLine,
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        current ? "bg-active font-medium text-foreground" : "text-subtle-foreground hover:bg-hover",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{hit.threadTitle}</span>
    </Link>
  );
}
