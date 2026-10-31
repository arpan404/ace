import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useInboxStore } from "./use-inbox-open.ts";

/** Paths the Threads panel shows beside. */
const threadsPlace = (path: string) =>
  path === "/" ||
  ["/t/", "/new", "/history", "/archived"].some((prefix) => path.startsWith(prefix));

/**
 * ⌘I, from anywhere: the Inbox over the Threads panel. From another place it goes to Threads
 * first, and a hidden sidebar comes back to show it; on Threads it opens or closes the Inbox.
 */
export function InboxKeys() {
  const inbox = useInboxStore();
  const layout = useLayout();
  const navigate = useNavigate();
  const onThreads = useRouterState({ select: (state) => threadsPlace(state.location.pathname) });
  useHotkey(keymap.inbox.keys, () => {
    if (!layout.layout.sidebarOpen) layout.setSidebarOpen(true);
    if (onThreads) return inbox.toggle();
    void navigate({ to: "/" });
    inbox.set(true);
  });
  return null;
}
