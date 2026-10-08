import type { PendingSend } from "@ace/client";
import { useIntent, usePendingSends, useSidebarIds } from "@ace/client-react";
import { provisionalTitle } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { startedTitle } from "@/features/thread/index.ts";
import { publishStartedTitles } from "./started-titles.ts";

const none: readonly string[] = [];

/** The thread a create became, once the daemon's receipt named it. */
function realId(send: PendingSend): string | undefined {
  return send.threadId.startsWith("pending:") ? undefined : send.threadId;
}

/** A started thread's title: the one New thread worked out, else from its first message. */
function titleOf(send: PendingSend): string {
  return startedTitle(send.commandId) ?? provisionalTitle(send.payload.input);
}

/**
 * Threads started from this window that the list doesn't show yet (UX audit SY-2): each is a
 * row at the top at once, dimmed until the daemon accepts it, opening the thread on its pending
 * route or its real one. Once the daemon lists the thread, its own row takes over, reading the
 * title published here while the daemon's still says "New thread".
 */
export function StartedRows() {
  const pending = usePendingSends();
  const listed = useSidebarIds() ?? none;
  const creates = useMemo(
    () =>
      pending.filter((send) => send.payload.type === "thread.create" && send.state !== "failed"),
    [pending],
  );
  useEffect(() => {
    const titles = new Map<string, string>();
    for (const send of creates) {
      const id = realId(send);
      if (id) titles.set(id, titleOf(send));
    }
    publishStartedTitles(titles);
  }, [creates]);
  const waiting = creates.filter((send) => {
    const id = realId(send);
    return !id || !listed.includes(id);
  });
  if (!waiting.length) return null;
  return (
    <ul aria-label="Starting threads" className="px-2 pb-1">
      {waiting.map((send) => (
        <StartedRow key={send.commandId} send={send} />
      ))}
    </ul>
  );
}

function StartedRow(props: { send: PendingSend }) {
  const { send } = props;
  const accepted = useIntent(send.commandId)?.state === "acked";
  return (
    <li>
      <Link
        to="/t/$threadId"
        params={{ threadId: realId(send) ?? `pending:${send.commandId}` }}
        className={cn(
          // The thread rows' shape, so the row doesn't jump when the daemon's row replaces it.
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-ui text-sidebar-foreground outline-none transition-[background-color,opacity] duration-(--dur-1) focus-ring-inset hover:bg-sidebar-accent",
          "data-[status=active]:bg-foreground/8",
          !accepted && "opacity-60",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {titleOf(send)}
          <span className="sr-only">. {accepted ? "Starting" : "Sending to the daemon"}</span>
        </span>
        <Spinner />
      </Link>
    </li>
  );
}
