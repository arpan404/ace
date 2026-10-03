import { useSidebarThread } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Dot } from "@/components/ui/dot.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { threadStatusLabel } from "@/lib/status.ts";
import { formatAge, useNow } from "@/lib/time.ts";

/**
 * One Home row: project and age, the title, and the status mark. Colour only for needs-you
 * and failed; working is a grey spinner; the status word is for assistive tech.
 * Subscribes to its own sidebar entry, so other threads' updates skip it.
 */
export function ThreadRow(props: { threadId: string }) {
  const thread = useSidebarThread(props.threadId);
  const now = useNow();
  if (!thread) return null;
  const status = threadStatusLabel(thread.status);
  const needsYou = thread.status.state === "needs_you";
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: thread.id }}
      className={cn(
        "group grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 rounded-md px-[11px] pt-[9px] pb-2.5 outline-none transition-colors duration-150 hover:bg-sidebar-accent compact:py-1.5",
        "data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]",
      )}
    >
      <span className="truncate text-[12px] text-subtle-foreground">{thread.workspaceId}</span>
      <span className="self-center text-xs whitespace-nowrap text-subtle-foreground">
        {formatAge(thread.updatedAt, now)}
      </span>
      <span
        className={cn(
          "col-span-2 line-clamp-2 text-base leading-[1.3] tracking-[-0.005em] text-muted-foreground compact:line-clamp-1",
          "group-data-[status=active]:font-medium group-data-[status=active]:text-foreground",
          needsYou && "font-medium text-foreground",
        )}
      >
        {thread.title}
      </span>
      <span className="col-start-2 flex items-center justify-end gap-2">
        <StatusMark status={thread.status} />
        <span className="sr-only">{status.label}</span>
      </span>
    </Link>
  );
}

function StatusMark(props: { status: ThreadStatus }) {
  switch (props.status.state) {
    case "needs_you":
      return <Dot tone="needs-you" />;
    case "failed":
      return <Dot tone="failed" />;
    case "unresponsive":
      return <Dot tone="unresponsive" />;
    case "working":
      return <Spinner />;
    default:
      return null;
  }
}
