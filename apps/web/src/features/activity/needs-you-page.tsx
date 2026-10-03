import { useInteractions, useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { BellIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Page, PageTitle } from "@/features/shell/screen.tsx";
import { useNeedsYouThreadIds } from "@/features/shell/use-threads.ts";
import { InteractionCard } from "./interaction-card.tsx";

/**
 * Everything waiting on a person, across threads. Thread status comes from the daemon.
 * TODO(activity slice): full cards with risk, "Always allow", J/K/A/D keys.
 */
export function NeedsYouPage() {
  const threads = useNeedsYouThreadIds();
  if (!threads.length)
    return (
      <EmptyState
        icon={BellIcon}
        title="Nothing needs you"
        description="Approvals, questions and escalations from every thread land here."
      />
    );
  return (
    <Page>
      <PageTitle
        title="Needs you"
        lede="Approvals, questions and escalations from every thread. Answer here, or open the thread for context."
      />
      <div className="mt-6 flex flex-col gap-6">
        {threads.map((id) => (
          <ThreadInteractions key={id} threadId={id} />
        ))}
      </div>
    </Page>
  );
}

function ThreadInteractions(props: { threadId: string }) {
  const thread = useSidebarThread(props.threadId);
  const open = useInteractions(props.threadId);
  if (!thread) return null;
  return (
    <section aria-labelledby={`needs-${thread.id}`} className="flex flex-col gap-2.5">
      <h3 id={`needs-${thread.id}`} className="text-[12px] text-subtle-foreground">
        {thread.workspaceId} ·{" "}
        <Link
          to="/t/$threadId"
          params={{ threadId: thread.id }}
          className="text-muted-foreground hover:text-foreground"
        >
          {thread.title}
        </Link>
      </h3>
      {(open ?? []).map((id) => (
        <InteractionCard key={id} threadId={props.threadId} interactionId={id} />
      ))}
    </section>
  );
}
