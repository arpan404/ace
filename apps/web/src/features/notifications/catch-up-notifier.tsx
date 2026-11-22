import { useClient } from "@ace/client-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { notifyInBrowser } from "@/lib/browser-notify.ts";
import { documentVisibility } from "@/lib/page-visibility.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";
import { useOwnNoticeSpace } from "@/features/ace-account/index.ts";
import { inSpaceWords } from "./notice-words.ts";

/**
 * The daemon's one alert after this device was away: how many threads still need the person.
 * It follows the needs-you toggle, and opens the longest-waiting thread. Mounted with the
 * shell, not after first paint, because it arrives right after the socket connects.
 */
export function CatchUpNotifier() {
  const client = useClient();
  const [prefs] = useNotificationPrefs();
  const toast = useToast();
  const navigate = useNavigate();
  const space = useOwnNoticeSpace();
  const latest = useRef({ prefs, toast, navigate, space });
  useEffect(() => {
    latest.current = { prefs, toast, navigate, space };
  });
  useEffect(() => {
    const seen = new Set<string>();
    return client.onMessage((message) => {
      if (message.type !== "notification" || message.notification.status !== "catch_up") return;
      const notice = message.notification;
      const current = latest.current;
      if (!current.prefs.needsYou || seen.has(notice.id)) return;
      seen.add(notice.id);
      if (seen.size > 100) seen.delete(seen.values().next().value ?? "");
      // A notice from another space opens there (ADR 0206 §1.5).
      const open = () => {
        current.space.enter();
        void current.navigate({ to: "/t/$threadId", params: { threadId: notice.threadId } });
      };
      const body = inSpaceWords(current.space.label, notice.message);
      if (!documentVisibility.visible()) {
        if (current.prefs.browser)
          notifyInBrowser({
            title: notice.title,
            body: body ?? "",
            tag: notice.id,
            open,
          });
        return;
      }
      current.toast.add({
        id: notice.id,
        eventId: notice.id,
        title: notice.title,
        description: body,
        timeout: 10_000,
        actionProps: { children: "Open", onClick: open },
      });
    });
  }, [client]);
  return null;
}
