import { useEffect } from "react";
import { hasDesktopBridge } from "@/boot/desktop.ts";

/*
 * System notifications from a browser tab (NT-05). One rule for the whole app:
 * - the window is in front: in-app toasts only;
 * - it isn't: the desktop app's own notifications, or, in a browser tab that allowed it, the
 *   Notification API. Nothing is ever shown twice.
 * The tab's title also carries the needs-you count, "(3) ace", so a background tab shows it.
 */

/** The desktop app routes system notifications itself (main process); the bridge says so. */
function inDesktopApp(): boolean {
  const ace: unknown = Reflect.get(globalThis, "ace");
  return hasDesktopBridge() && typeof ace === "object" && ace !== null && "electron" in ace;
}

export type BrowserPermission = "unsupported" | NotificationPermission;

/** Whether this window can show browser notifications, and whether the person allowed them. */
export function browserPermission(): BrowserPermission {
  if (inDesktopApp() || typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Asks once, from a click: browsers refuse a prompt that no gesture started. */
export async function requestBrowserPermission(): Promise<BrowserPermission> {
  if (browserPermission() === "unsupported") return "unsupported";
  return Notification.requestPermission();
}

/**
 * Shows a system notification from a browser tab, if it may; clicking it brings the tab
 * forward and runs `open`. A newer one with the same tag replaces the last. Returns whether
 * one was shown.
 */
export function notifyInBrowser(note: {
  title: string;
  body: string;
  tag: string;
  open(): void;
}): boolean {
  if (browserPermission() !== "granted") return false;
  const shown = new Notification(note.title, { body: note.body, tag: note.tag });
  shown.addEventListener("click", () => {
    window.focus();
    note.open();
    shown.close();
  });
  return true;
}

const counted = /^\(\d+\) /;

/** Prefixes the document title with a count, "(3) ", while it's above zero. */
export function useTitleCount(count: number): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const base = document.title.replace(counted, "");
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [count]);
  useEffect(
    () => () => {
      if (typeof document !== "undefined") document.title = document.title.replace(counted, "");
    },
    [],
  );
}
