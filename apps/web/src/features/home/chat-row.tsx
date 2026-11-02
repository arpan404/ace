import { useSidebarThread } from "@ace/client-react";
import { use } from "react";
import { ChatRowActions } from "./chat-row-actions.tsx";
import { FoundHits, FoundRow } from "./found-row.tsx";
import { ThreadRow } from "./thread-row.tsx";

/**
 * A chat in the Chats panel: a thread row (one line led by its provider's mark, its one mark,
 * the hover card) with a chat's
 * hover actions, dimmed while settled. An older chat only the search found draws from its hit.
 */
export function ChatRow(props: { id: string; settled: boolean; leaving: boolean }) {
  const listed = useSidebarThread(props.id) !== undefined;
  const hit = use(FoundHits).get(props.id);
  if (!listed && hit) return <FoundRow hit={hit} dimmed />;
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
