import { useNow } from "@/lib/time.ts";
import type { SidebarReader } from "@ace/client";
import {
  arrayEqual,
  useInteraction,
  useInteractions,
  useSidebarAll,
  useSidebarStore,
  useSidebarThread,
} from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { notifyInBrowser, useTitleCount } from "@/lib/browser-notify.ts";
import { documentVisibility } from "@/lib/page-visibility.ts";
import { interactionKey } from "./item-keys.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";
import { requestTitle } from "./request-title.ts";
import { threadToasts, type ToastCause } from "./toast-rules.ts";
import { useNeedsYouCount } from "./use-needs-you.ts";
import { useProjectName } from "@/lib/projects.ts";

// Automation runs and account limits are read after first paint: their toasts can wait.
const LaterNotifiers = lazy(() => import("./later-notifiers.tsx"));

/** A request or a failure stays until it's dealt with or 10 s pass, paused while hovered. */
const attentionTimeout = 10_000;
const needsToastId = (threadId: string) => `needs:${threadId}`;

const separator = "\u0000";
const readStatuses = (reader: SidebarReader) =>
  reader.ids.map((id) => `${id}${separator}${reader.thread(id)?.status.state ?? "new"}`);

/**
 * Turns live changes into notices: a thread that starts needing you or fails, automation
 * runs that finish, and accounts nearing, reaching or coming back from a usage limit. With the
 * window in front they're toasts; behind it, nothing here (the desktop app notifies, and a
 * browser tab that allowed it shows a system notification). The tab's title carries the
 * needs-you count. Mounted once in the shell; renders nothing.
 */
export function ActivityNotifier() {
  useTitleCount(useNeedsYouCount());
  return (
    <>
      <ThreadNotifier />
      <Suspense fallback={null}>
        <LaterNotifiers />
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
  const statuses = useSidebarAll(readStatuses, arrayEqual);
  const seenThreads = useRef<Map<string, ThreadStatus["state"]>>(undefined);
  const context = useRef({ prefs, pathname });
  // Threads with a needs-you toast up: each keeps its toast's words and life in step.
  const [waiting, setWaiting] = useState<readonly string[]>([]);

  const show = (cause: ToastCause) => {
    if (cause.kind === "automation") return;
    const thread = sidebar?.thread(cause.threadId);
    if (!thread || (thread.snoozedUntil ?? 0) > Date.now()) return;
    const needsYou = cause.kind === "needs_you";
    const visible = documentVisibility.visible();
    const description = `${projectName(thread.workspaceId)} · ${thread.title}`;
    if (needsYou) {
      const open = () => void navigate({ to: "/activity" });
      if (!visible) {
        if (context.current.prefs.browser)
          notifyInBrowser({
            title: `${thread.title} needs you`,
            body: projectName(thread.workspaceId),
            tag: needsToastId(thread.id),
            open,
          });
        return;
      }
      // Worded from the thread until its request loads (NeedsYouToast), then from the request.
      toast.add({
        id: needsToastId(thread.id),
        title: `${thread.title} needs you`,
        description,
        timeout: attentionTimeout,
        actionProps: { children: "Review", onClick: open },
        onClose: () => setWaiting((ids) => ids.filter((id) => id !== thread.id)),
      });
      setWaiting((ids) => (ids.includes(thread.id) ? ids : [...ids, thread.id]));
      return;
    }
    const open = () => void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    if (!visible) {
      if (context.current.prefs.browser)
        notifyInBrowser({
          title: `${thread.title} failed`,
          body: description,
          tag: thread.id,
          open,
        });
      return;
    }
    toast.error({
      title: `${thread.title} failed`,
      description: projectName(thread.workspaceId),
      timeout: attentionTimeout,
      actionProps: { children: "Open", onClick: open },
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
  return waiting.map((threadId) => <NeedsYouToast key={threadId} threadId={threadId} />);
}

/**
 * Keeps one needs-you toast true to its thread: it names the open request ("Allow a force
 * push to fix/restart-retry?") and Review opens that request in Activity; once the thread no
 * longer waits (answered, archived or settled) the toast goes.
 */
function NeedsYouToast(props: { threadId: string }) {
  const { threadId } = props;
  const toast = useToast();
  const navigate = useNavigate();
  // The toast API changes with every toast shown; the effects below must not re-run for that.
  const latest = useRef({ toast, navigate });
  useEffect(() => {
    latest.current = { toast, navigate };
  });
  const thread = useSidebarThread(threadId);
  const now = useNow();
  const first = useInteractions(threadId)?.[0];
  const interaction = useInteraction(threadId, first ?? "");
  const id = needsToastId(threadId);
  const left =
    thread !== undefined &&
    (thread.status.state !== "needs_you" ||
      thread.archivedAt !== undefined ||
      thread.deletedAt !== undefined ||
      (thread.snoozedUntil ?? 0) > now);
  useEffect(() => {
    if (left) latest.current.toast.close(id);
  }, [left, id]);
  const title = first && interaction ? requestTitle(interaction.request) : undefined;
  useEffect(() => {
    if (left || !title || !first) return;
    latest.current.toast.update(id, {
      title,
      actionProps: {
        children: "Review",
        onClick: () =>
          void latest.current.navigate({
            to: "/activity",
            search: { item: interactionKey(threadId, first) },
          }),
      },
    });
  }, [left, title, first, id, threadId]);
  return null;
}
