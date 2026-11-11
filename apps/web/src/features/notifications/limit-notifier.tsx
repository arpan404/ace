import { useConnectionState } from "@ace/client-react";
import { limitAlertWords, limitChanges, nextLimitReset, type LimitReading } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useAccountViews } from "@/features/accounts/index.ts";
import { usePageVisible } from "@/lib/page-visibility.ts";
import { useNotificationPrefs } from "./notification-prefs.ts";

/** How often quota is read for these toasts: the daemon pushes no quota changes. */
const refreshMs = 60_000;
/** Changes already toasted, by window period; forgotten past this many. */
const remembered = 256;
/** A timer longer than this overflows in browsers. */
const longestTimer = 2 ** 31 - 1;

/** Wait this long past a reset before reading again, for the provider to catch up. */
const resetGraceMs = 2_000;

/**
 * Toasts when an account nears its usage limit, reaches it, or can work again, while the
 * "limits" preference is on. Quota is read every minute while the app is visible, and again just
 * after the next reset of a window near or at its limit, while the page is shown and the daemon
 * connected. Each read is judged at the moment it was taken. Renders nothing.
 */
export default function LimitNotifier() {
  const [prefs] = useNotificationPrefs();
  const accounts = useAccountViews({ enabled: prefs.limits, refreshMs });
  const { data, dataUpdatedAt, refetch } = accounts;
  const visible = usePageVisible();
  const connected = useConnectionState() === "ready";
  const toast = useToast();
  const navigate = useNavigate();
  const reading = useRef<LimitReading>(undefined);
  const said = useRef(new Set<string>());
  const latest = useRef({ toast, navigate, on: prefs.limits });
  useEffect(() => {
    latest.current = { toast, navigate, on: prefs.limits };
  });

  // Every read counts, even one that returns the same quota: time alone can free an account.
  useEffect(() => {
    if (!data) return;
    const { changes, reading: next } = limitChanges(reading.current, data, dataUpdatedAt);
    reading.current = next;
    const { toast: toasts, navigate: go, on } = latest.current;
    // Other screens read accounts too; with the toasts off, their reads only move the reading on.
    if (!on) return;
    const now = Date.now();
    for (const change of changes) {
      if (said.current.has(change.key)) continue;
      if (said.current.size >= remembered) said.current.clear();
      said.current.add(change.key);
      toasts.add({
        ...limitAlertWords(change, now),
        kind: `account-limit:${change.account.id}`,
        eventId: change.key,
        actionProps: { children: "View usage", onClick: () => void go({ to: "/usage" }) },
      });
    }
  }, [data, dataUpdatedAt]);

  // Read again just after the next reset, so "can work again" arrives when it happens. Hidden or
  // offline, nothing is scheduled; once back, a reset that passed meanwhile is read at once.
  useEffect(() => {
    if (!data || !prefs.limits || !visible || !connected) return;
    const at = nextLimitReset(data, dataUpdatedAt);
    if (at === undefined) return;
    const delay = Math.max(0, at - Date.now()) + resetGraceMs;
    const timer = setTimeout(() => void refetch(), Math.min(delay, longestTimer));
    return () => clearTimeout(timer);
  }, [data, dataUpdatedAt, prefs.limits, visible, connected, refetch]);
  return null;
}
