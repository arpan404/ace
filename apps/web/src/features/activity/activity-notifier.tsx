import type { SidebarReader } from "@ace/client";
import {
  arrayEqual,
  useSidebar,
  useSidebarIds,
  useSidebarStore,
  type SidebarKey,
} from "@ace/client-react";
import type { AutomationRun, ThreadStatus } from "@ace/protocol";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useAutomationRuns } from "@/features/automations/index.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";
import { runToasts, threadToasts, type ToastCause } from "./toast-rules.ts";

const none: readonly string[] = [];
const separator = "\u0000";
const readStatuses = (reader: SidebarReader) =>
  reader.ids.map((id) => `${id}${separator}${reader.thread(id)?.status.state ?? "new"}`);

/**
 * Turns live changes into in-app toasts: a thread that starts needing you or fails, and
 * automation runs that finish. Mounted once in the shell; renders nothing.
 */
export function ActivityNotifier() {
  const [prefs] = useNotificationPrefs();
  const toast = useToast();
  const navigate = useNavigate();
  const sidebar = useSidebarStore();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  const statuses = useSidebar(keys, readStatuses, arrayEqual);
  const runs = useAutomationRuns().data;
  const seenThreads = useRef<Map<string, ThreadStatus["state"]>>(undefined);
  const seenRuns = useRef<readonly AutomationRun[]>(undefined);
  const context = useRef({ prefs, pathname });

  const show = (cause: ToastCause) => {
    if (cause.kind === "automation") {
      const { run } = cause;
      toast.add({
        title: run.status === "failed" ? `${run.title} failed` : `${run.title} finished`,
        description: run.result ?? "",
        actionProps: {
          children: "Open",
          onClick: () =>
            void (run.threadId
              ? navigate({ to: "/t/$threadId", params: { threadId: run.threadId } })
              : navigate({
                  to: "/automations/$automationId",
                  params: { automationId: run.automationId },
                })),
        },
      });
      return;
    }
    const thread = sidebar?.thread(cause.threadId);
    if (!thread) return;
    const needsYou = cause.kind === "needs_you";
    toast.add({
      title: thread.title,
      description: `${thread.workspaceId} · ${needsYou ? "needs you" : "failed"}`,
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

  useEffect(() => {
    if (!runs) return;
    const previous = seenRuns.current;
    seenRuns.current = runs;
    for (const cause of runToasts(previous, runs, context.current.prefs)) showRef.current(cause);
  }, [runs]);
  return null;
}
