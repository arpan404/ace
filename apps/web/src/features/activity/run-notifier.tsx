import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useAutomationRuns } from "@/features/automations/index.ts";
import { notifyInBrowser } from "@/lib/browser-notify.ts";
import { documentVisibility } from "@/lib/page-visibility.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";
import { runToasts } from "./toast-rules.ts";

/** A failed run's toast stays as long as a request's: it wants a look. */
const failedTimeout = 10_000;

/**
 * Toasts for automation runs that finish while the app is open, once each. While the window
 * is hidden there's no toast; a browser tab that allowed it shows a system notification.
 * Renders nothing.
 */
export default function RunNotifier() {
  const [prefs] = useNotificationPrefs();
  const toast = useToast();
  const navigate = useNavigate();
  const runs = useAutomationRuns().data;
  const [since] = useState(() => Date.now());
  const toasted = useRef(new Set<string>());
  const latest = useRef({ prefs, toast, navigate });
  useEffect(() => {
    latest.current = { prefs, toast, navigate };
  });
  useEffect(() => {
    if (!runs) return;
    const { prefs: current, toast: toasts, navigate: go } = latest.current;
    for (const cause of runToasts(runs, current, since, toasted.current)) {
      if (cause.kind !== "automation") continue;
      const { run } = cause;
      toasted.current.add(run.id);
      const open = () =>
        void go({ to: "/activity", search: { item: `run:${run.id}` } satisfies { item: string } });
      const title = run.status === "failed" ? `${run.title} failed` : `${run.title} finished`;
      if (!documentVisibility.visible()) {
        if (current.browser) notifyInBrowser({ title, body: run.result ?? "", tag: run.id, open });
        continue;
      }
      toasts.add({
        id: `run:${run.id}`,
        title,
        description: run.result ?? "",
        ...(run.status === "failed" ? { timeout: failedTimeout } : {}),
        actionProps: { children: "Open", onClick: open },
      });
    }
  }, [runs, since]);
  return null;
}
