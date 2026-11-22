import { useClient, useSidebarStore } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { notifyInBrowser } from "@/lib/browser-notify.ts";
import { documentVisibility } from "@/lib/page-visibility.ts";
import { notificationTitle } from "@/lib/notification-title.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";
import { isSnoozedToTime } from "@ace/ui-core";
import type { ThreadListEntry } from "@ace/protocol";
import { useOwnNoticeSpace } from "@/features/ace-account/index.ts";
import { inSpaceWords } from "./notice-words.ts";

/** The person snoozed the thread to a time: its agent's words wait with it. */
const snoozedToTime = (thread: ThreadListEntry | undefined) =>
  thread !== undefined && isSnoozedToTime(thread, Date.now());

/** Agent notices already passed delivery policy; use their stable id to replace retries. */
export function AgentNotifier() {
  const client = useClient();
  const sidebar = useSidebarStore();
  const [prefs] = useNotificationPrefs();
  const toast = useToast();
  const navigate = useNavigate();
  const space = useOwnNoticeSpace();
  const latest = useRef({ prefs, toast, navigate, space });
  useEffect(() => {
    latest.current = { prefs, toast, navigate, space };
  });
  useEffect(() => {
    let stopped = false;
    const sync = () => {
      void client
        .request({ type: "notification.config" })
        .then((reply) => {
          if (!stopped)
            client.send({
              type: "notification.preferences",
              preferences: { ...reply.preferences, agentSays: prefs.agentSays },
            });
        })
        .catch(() => {});
    };
    sync();
    const stop = client.connectionState().subscribe(sync);
    return () => {
      stopped = true;
      stop();
    };
  }, [client, prefs.agentSays]);
  useEffect(() => {
    const seen = new Set<string>();
    return client.onMessage((message) => {
      if (message.type !== "notification" || message.notification.status !== "agent_says") return;
      const notice = message.notification;
      const current = latest.current;
      if (
        !current.prefs.agentSays ||
        seen.has(notice.id) ||
        snoozedToTime(sidebar?.thread(notice.threadId))
      )
        return;
      seen.add(notice.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value ?? "");
      // A notice from another space opens there (ADR 0206 §1.5).
      const open = () => {
        current.space.enter();
        void current.navigate({ to: "/t/$threadId", params: { threadId: notice.threadId } });
      };
      const body = inSpaceWords(current.space.label, notice.message);
      if (!documentVisibility.visible()) {
        if (current.prefs.browser)
          notifyInBrowser({
            title: notificationTitle(notice),
            body: body ?? "",
            tag: notice.id,
            open,
          });
        return;
      }
      current.toast.add({
        id: notice.id,
        eventId: notice.id,
        title: notificationTitle(notice),
        description: body,
        timeout: 10_000,
        actionProps: { children: "Open", onClick: open },
      });
    });
  }, [client, sidebar]);
  return null;
}
