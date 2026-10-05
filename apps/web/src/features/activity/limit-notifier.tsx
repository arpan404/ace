import {
  accountName,
  limitChanges,
  nextLimitReset,
  type AccountView,
  type LimitChange,
} from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { formatResetCountdown, useAccountViews } from "@/features/accounts/index.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";

/** How often quota is read for these toasts: the daemon pushes no quota changes. */
const refreshMs = 60_000;
/** Changes already toasted, by window period; forgotten past this many. */
const remembered = 256;
/** A timer longer than this overflows in browsers. */
const longestTimer = 2 ** 31 - 1;

function words(change: LimitChange, now: number): { title: string; description: string } {
  const name = accountName(change.account);
  switch (change.kind) {
    case "near":
      return {
        title: `${name} is near its usage limit`,
        description: `${change.window.usedPercent}% of the ${change.window.label} window used. ${formatResetCountdown(change.window.resetsAt, now)}.`,
      };
    case "reached":
      return {
        title: `${name} reached its usage limit`,
        description:
          change.resetsAt === undefined
            ? "The provider didn't say when it resets."
            : `${formatResetCountdown(change.resetsAt, now)}.`,
      };
    case "reset":
      return { title: `${name} can work again`, description: "Its usage window has reset." };
  }
}

/**
 * Toasts when an account nears its usage limit, reaches it, or can work again, while the
 * "limits" preference is on. Quota is read every minute while the app is visible, and again just
 * after the next reset of a window near or at its limit. Renders nothing.
 */
export default function LimitNotifier() {
  const [prefs] = useNotificationPrefs();
  const accounts = useAccountViews({ enabled: prefs.limits, refreshMs });
  const { data, refetch } = accounts;
  const toast = useToast();
  const navigate = useNavigate();
  const seen = useRef<readonly AccountView[]>(undefined);
  const said = useRef(new Set<string>());
  const latest = useRef({ toast, navigate, on: prefs.limits });
  useEffect(() => {
    latest.current = { toast, navigate, on: prefs.limits };
  });

  useEffect(() => {
    if (!data) return;
    const previous = seen.current;
    seen.current = data;
    const now = Date.now();
    const { toast: toasts, navigate: go, on } = latest.current;
    // Other screens read accounts too; with the toasts off, their reads only move `seen` on.
    if (!on) return;
    for (const change of limitChanges(previous, data)) {
      if (said.current.has(change.key)) continue;
      if (said.current.size >= remembered) said.current.clear();
      said.current.add(change.key);
      toasts.add({
        ...words(change, now),
        actionProps: { children: "View usage", onClick: () => void go({ to: "/more/accounts" }) },
      });
    }
  }, [data]);

  // Read again just after the next reset, so "can work again" arrives when it happens.
  useEffect(() => {
    if (!data || !prefs.limits) return;
    const now = Date.now();
    const at = nextLimitReset(data, now);
    if (at === undefined) return;
    const timer = setTimeout(() => void refetch(), Math.min(at - now + 2_000, longestTimer));
    return () => clearTimeout(timer);
  }, [data, prefs.limits, refetch]);
  return null;
}
