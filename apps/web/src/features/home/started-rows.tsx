import type { PendingSend } from "@ace/client";
import { useIntent, usePendingSends, useSidebarIds } from "@ace/client-react";
import { provisionalTitle } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useSyncExternalStore } from "react";
import { dismissedSends, loadDismissed } from "@/lib/dismissed-sends.ts";
import { useLayout } from "@/lib/layout.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { providerNames } from "@ace/ui-core";
import { useProjectName } from "@/lib/projects.ts";
import { Dot } from "@/components/ui/dot.tsx";
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
 * route or its real one. Once the daemon accepts the create, its own row takes over, reading
 * the title published here while the daemon's still says "New thread". Successful receipts
 * must never become provisional rows again when a thread leaves the list.
 */
export function StartedRows() {
  const { storage } = useLayout();
  loadDismissed(storage);
  const dismissed = useSyncExternalStore(dismissedSends.subscribe, dismissedSends.get);
  const pending = usePendingSends();
  const listed = useSidebarIds() ?? none;
  const creates = useMemo(
    () =>
      pending.filter(
        (send) => send.payload.type === "thread.create" && !dismissed.has(send.commandId),
      ),
    [pending, dismissed],
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
    return (
      (send.state === "saving" || send.state === "sent" || send.state === "failed") &&
      (!id || !listed.includes(id))
    );
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
  const name = useProjectName();
  const failed = send.state === "failed";
  const label = failed ? "Not sent" : accepted ? "Starting" : "Sending";
  const project = name(send.payload.type === "thread.create" ? send.payload.workspaceId : "");
  const provider =
    send.payload.type === "thread.create" ? providerNames[send.payload.provider] : "";
  return (
    <li>
      <Link
        to="/t/$threadId"
        params={{ threadId: realId(send) ?? `pending:${send.commandId}` }}
        aria-label={`${titleOf(send)}. ${label}, ${provider}, Project ${project}`}
        className={cn(
          // The thread rows' shape, so the row doesn't jump when the daemon's row replaces it.
          "flex h-8 pointer-coarse:h-11 w-full items-center gap-1.5 rounded-md px-2 text-ui text-sidebar-foreground outline-none transition-[background-color,opacity] duration-(--dur-1) focus-ring-inset hover:bg-sidebar-accent",
          "data-[status=active]:bg-foreground/8",
          !accepted && !failed && "opacity-60",
        )}
      >
        <span aria-hidden className="grid w-3 shrink-0 place-items-center">
          {failed ? <Dot tone="failed" /> : <Spinner className="text-muted-foreground" />}
        </span>
        <span className="min-w-0 flex-1 truncate leading-4">{titleOf(send)}</span>
        {failed ? (
          <StatusLabel tone="failed" label={label} mark={false} />
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
        )}
      </Link>
    </li>
  );
}
