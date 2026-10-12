import type { PendingSend } from "@ace/client";
import { useConnectionState, useIntent, usePendingSends, useSidebarIds } from "@ace/client-react";
import { projectBadge, provisionalTitle } from "@ace/ui-core";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useSyncExternalStore } from "react";
import { dismissedSends, loadDismissed } from "@/lib/dismissed-sends.ts";
import { useLayout } from "@/lib/layout.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { providerNames } from "@ace/ui-core";
import { useProjectName } from "@/lib/projects.ts";
import { ProjectMark } from "@/components/project-mark.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { useHostIdentity } from "@/lib/host-name.ts";
import { cn } from "@/lib/cn.ts";
import { startedTitle } from "@/features/thread/index.ts";
import { useOrganizerState } from "@/features/organize/index.ts";
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
 * row in Unsent at once, opening the thread on its pending
 * route or its real one. Once the daemon accepts the create, its own row takes over, reading
 * the title published here while the daemon's still says "New thread". Successful receipts
 * must never become provisional rows again when a thread leaves the list.
 */
function useCreates() {
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
  return { creates, listed };
}

export function StartedTitlePublisher() {
  const { creates } = useCreates();
  useEffect(() => {
    const titles = new Map<string, string>();
    for (const send of creates) {
      const id = realId(send);
      if (id) titles.set(id, titleOf(send));
    }
    publishStartedTitles(titles);
  }, [creates]);
  return null;
}

export function StartedRows() {
  const { creates, listed } = useCreates();
  const { project } = useOrganizerState();
  const waiting = creates.filter((send) => {
    const id = realId(send);
    return (
      (send.state === "saving" || send.state === "sent" || send.state === "failed") &&
      (!id || !listed.includes(id)) &&
      (project === null ||
        (send.payload.type === "thread.create" && send.payload.workspaceId === project))
    );
  });
  if (!waiting.length) return null;
  return (
    <ul aria-label="Starting threads" className="pb-1">
      {waiting.map((send) => (
        <StartedRow key={send.commandId} send={send} />
      ))}
    </ul>
  );
}

function StartedRow(props: { send: PendingSend }) {
  const { send } = props;
  const state = useConnectionState();
  const host = useHostIdentity();
  const accepted = useIntent(send.commandId)?.state === "acked";
  const name = useProjectName();
  const failed = send.state === "failed";
  const label = failed
    ? "Not sent"
    : state !== "ready"
      ? "Sends on reconnect"
      : accepted
        ? "Starting"
        : "Sending";
  const projectId = send.payload.type === "thread.create" ? send.payload.workspaceId : "";
  const project = name(projectId);
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
          "flex h-21 w-full flex-col justify-center gap-0.5 border-b border-sidebar-border px-3 py-3 text-ui text-foreground outline-none transition-[background-color,opacity] duration-(--dur-1) focus-ring-inset hover:bg-foreground/3",
          "data-[status=active]:bg-foreground/3",
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProjectMark badge={projectBadge({ id: projectId, name: project })} />
          <span className="min-w-0 flex-1 truncate">{project}</span>
          {failed ? (
            <StatusLabel tone="failed" label={label} mark={false} className="font-normal" />
          ) : (
            <span className="shrink-0">{label}</span>
          )}
        </span>
        <span className="w-full truncate text-base leading-5">{titleOf(send)}</span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <MachineMark icon={host?.icon} />
          <span className="truncate">{host?.displayName ?? "This machine"}</span>
          {send.payload.type === "thread.create" && (
            <ProviderIcon
              provider={send.payload.provider}
              size={14}
              className="ml-auto"
              decorative
            />
          )}
        </span>
      </Link>
    </li>
  );
}
