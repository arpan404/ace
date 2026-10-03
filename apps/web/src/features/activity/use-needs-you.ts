import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import { useCallback, useMemo } from "react";
import { useThreadIdsWhere } from "@/features/shell/index.ts";
import { inProject, useActivityState } from "./activity-state.tsx";
import { useDeckEvents } from "./escalations.ts";
import type { FeedEvent } from "./feed-events.ts";

/**
 * A stable set of the threads decks own, so selectors keep their identity while the decks'
 * views change without adding or removing a thread.
 */
function useOwned(threads: ReadonlyMap<string, unknown>): ReadonlySet<string> {
  const key = [...threads.keys()].toSorted().join("\u0000");
  return useMemo(() => new Set(key ? key.split("\u0000") : []), [key]);
}

/**
 * Threads waiting on a person (live from the daemon) and open Deck decisions, filtered. A
 * deck's own threads are left out: their requests are the deck's decisions.
 */
export function useNeedsYou(): { threadIds: readonly string[]; escalations: FeedEvent[] } {
  const { project } = useActivityState();
  const deck = useDeckEvents();
  const owned = useOwned(deck.threads);
  const predicate = useCallback(
    (reader: SidebarReader, id: string) => {
      const thread = reader.thread(id);
      return (
        thread?.status.state === "needs_you" &&
        !owned.has(id) &&
        inProject(project, thread.workspaceId)
      );
    },
    [project, owned],
  );
  const threadIds = useThreadIdsWhere(predicate);
  const escalations = useMemo(
    () => deck.events.filter((event) => inProject(project, event.project)),
    [deck.events, project],
  );
  return { threadIds, escalations };
}

/** Every open request across threads (the daemon's per-thread counts) plus Deck decisions. */
export function useNeedsYouCount(): number {
  const deck = useDeckEvents();
  const owned = useOwned(deck.threads);
  const pendingTotal = useCallback(
    (reader: SidebarReader) =>
      reader.ids.reduce((sum, id) => {
        const status = reader.thread(id)?.status;
        return status?.state === "needs_you" && !owned.has(id) ? sum + status.interactions : sum;
      }, 0),
    [owned],
  );
  const pending = useSidebarAll(pendingTotal) ?? 0;
  return pending + deck.events.length;
}
