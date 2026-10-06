import type { SidebarReader } from "@ace/client";
import { useSidebarAll } from "@ace/client-react";
import { useCallback, useMemo } from "react";
import { useThreadIdsWhere } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { inProject, useActivityState } from "./activity-state.tsx";
import { useDeckEvents } from "./escalations.ts";
import type { FeedEvent } from "./feed-events.ts";
import { useWaitingSince } from "./waiting-since.tsx";

/**
 * A stable set of the threads decks own, so selectors keep their identity while the decks'
 * views change without adding or removing a thread.
 */
function useOwned(threads: ReadonlyMap<string, unknown>): ReadonlySet<string> {
  const key = [...threads.keys()].toSorted().join("\u0000");
  return useMemo(() => new Set(key ? key.split("\u0000") : []), [key]);
}

/** One thing waiting on a person: a thread's open requests, or a deck's decision. */
export type NeedsYouEntry =
  | { kind: "thread"; threadId: string; since: number }
  | { kind: "escalation"; event: FeedEvent; since: number };

/** Waiting on a person and not snoozed by them, in a project the filter passes. */
function waiting(
  reader: SidebarReader,
  id: string,
  owned: ReadonlySet<string>,
  project: string | undefined,
  now: number,
): boolean {
  const thread = reader.thread(id);
  return (
    thread?.status.state === "needs_you" &&
    !owned.has(id) &&
    !((thread.snoozedUntil ?? 0) > now) &&
    inProject(project, thread.workspaceId)
  );
}

/**
 * Threads waiting on a person (live from the daemon) and open Deck decisions, filtered, in
 * the order they started waiting, oldest first. A deck's own threads are left out: their
 * requests are the deck's decisions. Snoozed threads wait until they wake.
 */
export function useNeedsYou(): {
  threadIds: readonly string[];
  escalations: FeedEvent[];
  entries: readonly NeedsYouEntry[];
} {
  const { project } = useActivityState();
  const deck = useDeckEvents();
  const owned = useOwned(deck.threads);
  // Snoozes end on the minute; the list follows.
  const now = useNow();
  const minute = Math.floor(now / 60_000);
  const predicate = useCallback(
    (reader: SidebarReader, id: string) => waiting(reader, id, owned, project, minute * 60_000),
    [project, owned, minute],
  );
  const threadIds = useThreadIdsWhere(predicate);
  const since = useWaitingSince();
  const escalations = useMemo(
    () => deck.events.filter((event) => inProject(project, event.project)),
    [deck.events, project],
  );
  const entries = useMemo(() => {
    const all: NeedsYouEntry[] = [
      ...threadIds.map((threadId) => ({
        kind: "thread" as const,
        threadId,
        since: since.get(threadId) ?? Number.MAX_SAFE_INTEGER,
      })),
      ...escalations.map((event) => ({ kind: "escalation" as const, event, since: event.at })),
    ];
    return all.toSorted((a, b) => a.since - b.since);
  }, [threadIds, escalations, since]);
  return { threadIds, escalations, entries };
}

/**
 * Open requests across threads (the daemon's per-thread counts) plus Deck decisions, leaving
 * out snoozed threads as the list does. With a project, only that project's; the rail's badge
 * passes none and counts every project.
 */
export function useNeedsYouCount(options: { project?: string | undefined } = {}): number {
  const { project } = options;
  const deck = useDeckEvents();
  const owned = useOwned(deck.threads);
  const minute = Math.floor(useNow() / 60_000);
  const pendingTotal = useCallback(
    (reader: SidebarReader) =>
      reader.ids.reduce((sum, id) => {
        const status = reader.thread(id)?.status;
        return status?.state === "needs_you" && waiting(reader, id, owned, project, minute * 60_000)
          ? sum + status.interactions
          : sum;
      }, 0),
    [owned, project, minute],
  );
  const pending = useSidebarAll(pendingTotal) ?? 0;
  return pending + deck.events.filter((event) => inProject(project, event.project)).length;
}
