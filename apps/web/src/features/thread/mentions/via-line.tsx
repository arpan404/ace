import type { MessageVia } from "@ace/protocol";
import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { useMachineSearch } from "@/lib/machine-routes.ts";

/**
 * Above a message the person sent this thread's agent from another thread with `@` (ADR 0198):
 * "You, from ‹that thread›", opening it. Quiet at rest, like the line naming another agent.
 */
export function ViaLine(props: { via: MessageVia }) {
  const thread = useSidebarThread(props.via.threadId);
  const search = useMachineSearch();
  const title = thread?.title ?? props.via.title ?? "another thread";
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.via.threadId }}
      search={search}
      className="focus-ring mb-1 flex max-w-[80%] min-w-0 items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
    >
      <span className="truncate">You, from {title}</span>
    </Link>
  );
}
