import type { SidebarReader } from "@ace/client";
import { useSidebar } from "@ace/client-react";
import { useParams, useRouterState } from "@tanstack/react-router";
import { useCallback, useState } from "react";
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
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  const isChat = useIsChatThread();
  const openIsChat = useSidebar(
    ["ids", "threads"],
    useCallback(
      (reader: SidebarReader) => {
        const entry = threadId ? reader.thread(threadId) : undefined;
        return entry ? isChat(entry) : undefined;
      },
      [threadId, isChat],
    ),
  );
  const [previous, setPrevious] = useState<RailPlace>();
  const place = railPlace({ pathname, newProject, openIsChat, previous });
  if (place !== previous) setPrevious(place);
  return place;
}
