import { useInteractions, useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty.tsx";
import { useNeedsYouThreadIds } from "@/features/shell/use-threads.ts";
import { InteractionCard } from "./interaction-card.tsx";

/** Everything waiting on a person, across threads. Thread status comes from the daemon. */
export function InboxPage() {
  const threads = useNeedsYouThreadIds();
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
      <h1 className="text-lg font-medium">Needs you</h1>
      {threads.length ? (
        threads.map((id) => <ThreadInteractions key={id} threadId={id} />)
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing needs you</EmptyTitle>
            <EmptyDescription>Approvals and questions from agents appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function ThreadInteractions(props: { threadId: string }) {
  const thread = useSidebarThread(props.threadId);
  const open = useInteractions(props.threadId);
  if (!thread) return null;
  return (
    <section aria-labelledby={`inbox-${thread.id}`} className="flex flex-col gap-3">
      <h2 id={`inbox-${thread.id}`} className="text-sm font-medium">
        <Link
          to="/w/$workspaceId/t/$threadId"
          params={{ workspaceId: thread.workspaceId, threadId: thread.id }}
          className="hover:underline"
        >
          {thread.title}
        </Link>
      </h2>
      {(open ?? []).map((id) => (
        <InteractionCard key={id} threadId={props.threadId} interactionId={id} />
      ))}
    </section>
  );
}
