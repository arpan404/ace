import { useSidebarThread, useThreadMeta } from "@ace/client-react";
import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useIsChatThread } from "@/lib/projects.ts";
import { railPlace, type RailPlace } from "./views.ts";

/**
 * The rail's current place (`railPlace`): Chats while a chat (or New thread for one) is open,
 * Threads for any other thread. The rail highlights it and the sidebar shows its panel.
 */
export function useRailPlace(): RailPlace {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const newProject = useRouterState({
    select: (state) => {
      const search: { project?: unknown } = state.location.search;
      return typeof search.project === "string" ? search.project : undefined;
    },
  });
  // Another machine's thread (ADR 0102) is read under that machine's client, not this one.
  const elsewhere = useRouterState({
    select: (state) => {
      const search: { machine?: unknown } = state.location.search;
      return typeof search.machine === "string";
    },
  });
  // From the address itself: a route's params lag its address for a render while it changes.
  const threadId = openThreadOf(pathname);
  const isChat = useIsChatThread();
  const listed = useSidebarThread(threadId ?? "");
  // A chat the list hasn't paged in is known by the open thread's own details (the thread
  // screen holds the same subscription).
  const meta = useThreadMeta(listed || elsewhere ? undefined : threadId);
  const open = listed ?? meta;
  const openIsChat = threadId && open ? isChat(open) : undefined;
  const [previous, setPrevious] = useState<{ place: RailPlace; pathname: string }>();
  const place = railPlace({ pathname, newProject, openIsChat, previous });
  if (!previous || place !== previous.place || pathname !== previous.pathname)
    setPrevious({ place, pathname });
  return place;
}

/** The thread `/t/<id>` (or one of its pages) shows. */
function openThreadOf(pathname: string): string | undefined {
  const id = /^\/t\/([^/]+)/.exec(pathname)?.[1];
  if (!id) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}
