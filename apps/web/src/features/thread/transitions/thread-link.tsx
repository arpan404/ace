import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { useMachineSearch } from "@/lib/machine-routes.ts";

/** Lineage links use the thread list's live title, including renames. */
export function ThreadLink(props: { threadId: string; fallback: string }) {
  const thread = useSidebarThread(props.threadId);
  const search = useMachineSearch();
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      search={search}
      className="underline-offset-2 hover:text-foreground hover:underline"
    >
      {thread?.title ?? props.fallback}
    </Link>
  );
}
