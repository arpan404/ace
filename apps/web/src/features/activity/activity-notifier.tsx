import type { SidebarReader } from "@ace/client";
import {
  arrayEqual,
  useSidebar,
  useSidebarIds,
  useSidebarStore,
  type SidebarKey,
} from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useNotificationPrefs } from "./notification-prefs.ts";
import { threadToasts, type ToastCause } from "./toast-rules.ts";
import { useProjectName } from "@/lib/projects.ts";

// Automation runs are read after first paint: their toasts can wait for the shell to draw.
const RunNotifier = lazy(() => import("./run-notifier.tsx"));

const none: readonly string[] = [];
const separator = "\u0000";
const readStatuses = (reader: SidebarReader) =>
  reader.ids.map((id) => `${id}${separator}${reader.thread(id)?.status.state ?? "new"}`);

/**
 * Turns live changes into in-app toasts: a thread that starts needing you or fails, and
 * automation runs that finish. Mounted once in the shell; renders nothing.
 */
export function ActivityNotifier() {
  return (
    <>
      <ThreadNotifier />
      <Suspense fallback={null}>
        <RunNotifier />
      </Suspense>
    </>
  );
}

function ThreadNotifier() {
  const [prefs] = useNotificationPrefs();
  const toast = useToast();
  const projectName = useProjectName();
  const navigate = useNavigate();
  const sidebar = useSidebarStore();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  const statuses = useSidebar(keys, readStatuses, arrayEqual);
  const seenThreads = useRef<Map<string, ThreadStatus["state"]>>(undefined);
  const context = useRef({ prefs, pathname });

  const show = (cause: ToastCause) => {
    if (cause.kind === "automation") return;
    const thread = sidebar?.thread(cause.threadId);
    if (!thread) return;
    const needsYou = cause.kind === "needs_you";
    toast.add({
      title: thread.title,
      description: `${projectName(thread.workspaceId)} · ${needsYou ? "needs you" : "failed"}`,
      actionProps: {
        children: needsYou ? "Answer" : "Open",
        onClick: () =>
          void (needsYou
            ? navigate({ to: "/activity" })
            : navigate({ to: "/t/$threadId", params: { threadId: thread.id } })),
      },
    });
  };
  const showRef = useRef(show);
  useEffect(() => {
    context.current = { prefs, pathname };
    showRef.current = show;
  });

  useEffect(() => {
    if (!statuses || !sidebar) return;
    const next = new Map<string, ThreadStatus["state"]>();
    for (const id of sidebar.ids) next.set(id, sidebar.thread(id)?.status.state ?? "new");
    const previous = seenThreads.current;
    seenThreads.current = next;
    if (!previous) return;
    const { prefs: current, pathname: path } = context.current;
    const viewing = /^\/t\/([^/]+)/.exec(path)?.[1];
    for (const cause of threadToasts(previous, next, current, viewing))
      if (!(cause.kind === "needs_you" && path.startsWith("/activity"))) showRef.current(cause);
  }, [statuses, sidebar]);
  return null;
}
