import type { SidebarReader } from "@ace/client";
import { useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import { useCallback, useMemo } from "react";
import { useThreadIdsWhere } from "@/features/shell/index.ts";
import { inProject, useActivityState } from "./activity-state.tsx";
import { useEscalations } from "./escalations.ts";
import type { FeedEvent } from "./feed-events.ts";

const none: readonly string[] = [];

/** Threads waiting on a person (live from the daemon) and open Deck escalations, filtered. */
export function useNeedsYou(): { threadIds: readonly string[]; escalations: FeedEvent[] } {
  const { project } = useActivityState();
  const predicate = useCallback(
    (reader: SidebarReader, id: string) => {
      const thread = reader.thread(id);
      return thread?.status.state === "needs_you" && inProject(project, thread.workspaceId);
    },
    [project],
  );
  const threadIds = useThreadIdsWhere(predicate);
  const events = useEscalations();
  const escalations = useMemo(
    () => events.filter((event) => inProject(project, event.project)),
    [events, project],
  );
  return { threadIds, escalations };
}

const pendingTotal = (reader: SidebarReader) =>
  reader.ids.reduce((sum, id) => {
    const status = reader.thread(id)?.status;
    return status?.state === "needs_you" ? sum + status.interactions : sum;
  }, 0);

/** Every open request across threads (the daemon's per-thread counts) plus escalations. */
export function useNeedsYouCount(): number {
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  const pending = useSidebar(keys, pendingTotal) ?? 0;
  const escalations = useEscalations();
  return pending + escalations.length;
}
