import type { AutomationRun } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useAutomationRuns } from "@/features/automations/index.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";
import { runToasts } from "./toast-rules.ts";

/** Toasts for automation runs that finish while the app is open. Renders nothing. */
export default function RunNotifier() {
  const [prefs] = useNotificationPrefs();
  const toast = useToast();
  const navigate = useNavigate();
  const runs = useAutomationRuns().data;
  const seen = useRef<readonly AutomationRun[]>(undefined);
  const latest = useRef({ prefs, toast, navigate });
  useEffect(() => {
    latest.current = { prefs, toast, navigate };
  });
  useEffect(() => {
    if (!runs) return;
    const previous = seen.current;
    seen.current = runs;
    const { prefs: current, toast: toasts, navigate: go } = latest.current;
    for (const cause of runToasts(previous, runs, current)) {
      if (cause.kind !== "automation") continue;
      const { run } = cause;
      toasts.add({
        title: run.status === "failed" ? `${run.title} failed` : `${run.title} finished`,
        description: run.result ?? "",
        actionProps: {
          children: "Open",
          onClick: () =>
            void (run.threadId
              ? go({ to: "/t/$threadId", params: { threadId: run.threadId } })
              : go({
                  to: "/automations/$automationId",
                  params: { automationId: run.automationId },
                })),
        },
      });
    }
  }, [runs]);
  return null;
}
