import type { AutomationRun } from "@ace/protocol";
import { useMemo } from "react";
import { useAutomations } from "@/features/automations/index.ts";
import { useNow } from "@/lib/time.ts";
import {
  eventKey,
  inProject,
  runKey,
  useActivityState,
  type ActivityTab,
} from "./activity-state.tsx";
import { runAt, useFeed, type FeedEvent } from "./feed-source.ts";

/** One feed item besides Needs you: an event or a run, with its key, time and read state. */
export type FeedItem =
  | { kind: "event"; key: string; id: string; at: number; read: boolean; event: FeedEvent }
  | { kind: "run"; key: string; id: string; at: number; read: boolean; run: AutomationRun };

const day = 86_400_000;

/** Runs whose automation belongs to the filtered project (all runs when unfiltered). */
function useProjectRuns(
  runs: readonly AutomationRun[] | undefined,
  project: string | undefined,
): readonly AutomationRun[] {
  const automations = useAutomations().data;
  return useMemo(() => {
    if (!runs) return [];
    if (project === undefined) return runs;
    const workspace = new Map(
      automations?.map((entry) => [entry.automation.id, entry.automation.workspace]),
    );
    return runs.filter((run) => workspace.get(run.automationId) === project);
  }, [runs, automations, project]);
}

/**
 * The feed's events and runs for a tab and the project filter, newest first: All shows every
 * event and the last day's runs, Mentions only mentions, Runs every run. Deck decisions are
 * Needs you's, not here.
 */
export function useFeedItems(tab?: ActivityTab): {
  items: readonly FeedItem[];
  /** False until the runs have arrived (or failed to). */
  loaded: boolean;
} {
  const state = useActivityState();
  const current = tab ?? state.tab;
  const { project } = state;
  const feed = useFeed();
  const runs = useProjectRuns(feed.runs, project);
  const now = useNow();
  const items = useMemo(() => {
    const events = feed.events.filter(
      (event) =>
        event.kind !== "escalation" &&
        inProject(project, event.project) &&
        (current === "all" || (current === "mentions" && event.kind === "mention")),
    );
    const shownRuns =
      current === "runs"
        ? runs
        : current === "all"
          ? runs.filter((run) => now - run.startedAt < day)
          : [];
    const all: FeedItem[] = [
      ...events.map((event) => ({
        kind: "event" as const,
        key: eventKey(event.id),
        id: event.id,
        at: event.at,
        // Until the cursor arrives nothing is called unread.
        read: !feed.readLoaded || feed.read.has(event.id),
        event,
      })),
      ...shownRuns.map((run) => ({
        kind: "run" as const,
        key: runKey(run.id),
        id: run.id,
        at: runAt(run),
        read: !feed.readLoaded || feed.read.has(run.id),
        run,
      })),
    ];
    return all.toSorted((a, b) => b.at - a.at);
  }, [feed, runs, project, current, now]);
  return { items, loaded: feed.runsSettled };
}

/** "Today", "Yesterday", "This week" or "Older", by the local calendar. */
export function timeGroup(at: number, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (at >= startOfToday) return "Today";
  if (at >= startOfToday - day) return "Yesterday";
  if (at >= startOfToday - 6 * day) return "This week";
  return "Older";
}
