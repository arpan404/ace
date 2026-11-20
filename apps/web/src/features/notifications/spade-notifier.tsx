import { useClient } from "@ace/client-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { notifyInBrowser } from "@/lib/browser-notify.ts";
import { browserClaim } from "@/lib/notice-claim.ts";
import { documentVisibility } from "@/lib/page-visibility.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";
import { openSpadeAgent, spadeShow, withinBurst } from "./spade-notice-rules.ts";

/**
 * Spade's alerts in this window (ADR 0194). Spade decided each reaches the person now and the
 * daemon delivered it once per device; this shows it as a toast while the window is in front
 * (never for the conversation on screen), else as one system notification across this
 * browser's tabs. The desktop app's own main process shows its system notifications.
 */
export function SpadeNotifier() {
  const client = useClient();
  const [prefs] = useNotificationPrefs();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const latest = useRef({ prefs, toast, navigate, location });
  useEffect(() => {
    latest.current = { prefs, toast, navigate, location };
  });
  useEffect(() => {
    const seen = new Set<string>();
    let recent: number[] = [];
    return client.onMessage((message) => {
      if (message.type !== "notification" || message.notification.status !== "spade") return;
      const notification = message.notification;
      if (seen.has(notification.id)) return;
      seen.add(notification.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value ?? "");
      const current = latest.current;
      recent = withinBurst(recent, Date.now());
      const shown = spadeShow(notification, {
        on: current.prefs.spade,
        visible: documentVisibility.visible(),
        openAgent: openSpadeAgent(
          current.location.pathname,
          current.location.search as Record<string, unknown>,
        ),
        recent,
      });
      if (shown.kind === "skip") return;
      const open =
        shown.kind === "burst"
          ? () => void current.navigate({ to: "/spade" })
          : () =>
              void current.navigate({
                to: "/spade/$agentId",
                params: { agentId: shown.agent },
                search: shown.request ? { request: shown.request } : {},
              });
      if (shown.kind === "toast" || (shown.kind === "burst" && documentVisibility.visible())) {
        current.toast.add({
          id: shown.tag,
          eventId: notification.id,
          title: shown.title,
          description: shown.body,
          timeout: 10_000,
          actionProps: { children: "Open", onClick: open },
        });
        return;
      }
      if (!current.prefs.browser) return;
      void browserClaim(notification.id).then((mine) => {
        if (mine) notifyInBrowser({ title: shown.title, body: shown.body, tag: shown.tag, open });
      });
    });
  }, [client]);
  return null;
}
