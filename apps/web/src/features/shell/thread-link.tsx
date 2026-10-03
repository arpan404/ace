import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { StatusPill } from "@/components/status-pill.tsx";
import { threadStatusLabel } from "@/lib/status.ts";

/** One sidebar row. Subscribes to its own entry only, so other threads' updates skip it. */
export function ThreadLink(props: { threadId: string; onNavigate?: (() => void) | undefined }) {
  const thread = useSidebarThread(props.threadId);
  if (!thread) return null;
  const status = threadStatusLabel(thread.status);
  return (
    <Link
      to="/w/$workspaceId/t/$threadId"
      params={{ workspaceId: thread.workspaceId, threadId: thread.id }}
      onClick={props.onNavigate}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium"
    >
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <StatusPill tone={status.tone} label={status.label} />
    </Link>
  );
}
