import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";

/** Lineage links use the thread list's live title, including renames. */
export function ThreadLink(props: { threadId: string; fallback: string }) {
  const thread = useSidebarThread(props.threadId);
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      className="underline-offset-2 hover:text-foreground hover:underline"
    >
      {thread?.title ?? props.fallback}
    </Link>
  );
}
