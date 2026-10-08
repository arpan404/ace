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
import { useDeckEvents } from "./escalations.ts";
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
  const deck = useDeckEvents();
  const seenThreads = useRef<Map<string, ThreadStatus["state"]>>(undefined);
  const context = useRef({ prefs, pathname });
  // Threads with a needs-you toast up: each keeps its toast's words and life in step.
  const [waiting, setWaiting] = useState<readonly string[]>([]);

  const show = (cause: ToastCause) => {
    if (cause.kind === "automation") return;
    const thread = sidebar?.thread(cause.threadId);
    if (!thread) return;
    const needsYou = cause.kind === "needs_you";
    const visible = documentVisibility.visible();
    // A deck's own threads speak as the deck: its decision, opening the deck.
    const owner = deck.threads.get(thread.id);
    if (owner) {
      if (context.current.pathname === `/offshifts/${owner.runId}`) return;
      const decision = deck.events.find((event) => event.runId === owner.runId);
      const title = needsYou
        ? (decision?.title ?? `${owner.deck} needs you`)
        : `${thread.title} failed`;
      const open = () => void navigate({ to: "/offshifts/$runId", params: { runId: owner.runId } });
      if (!visible) {
        if (context.current.prefs.browser)
          notifyInBrowser({ title, body: owner.deck, tag: needsToastId(thread.id), open });
        return;
      }
      toast.add({
        id: needsToastId(thread.id),
        title,
        description: `${projectName(owner.workspaceId)} · ${owner.deck}`,
        timeout: attentionTimeout,
        actionProps: { children: "Open offshift", onClick: open },
      });
      return;
    }
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
  const first = useInteractions(threadId)?.[0];
  const interaction = useInteraction(threadId, first ?? "");
  const id = needsToastId(threadId);
  const left =
    thread !== undefined &&
    (thread.status.state !== "needs_you" ||
      thread.archivedAt !== undefined ||
      thread.deletedAt !== undefined);
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
