import type { AutomationRun } from "@ace/protocol";
import { BellIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useAutomationRuns, useAutomations } from "@/features/automations/index.ts";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useNow } from "@/lib/time.ts";
import { inProject, useActivityState, type ActivityTab } from "./activity-state.tsx";
import { useFeed, type FeedEvent } from "./feed-source.ts";
import { EventRow, RunRow, ThreadNeedsRows } from "./feed-rows.tsx";
import { useNeedsYou, useNeedsYouCount } from "./use-needs-you.ts";

const tabs: { id: ActivityTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "mentions", label: "Mentions" },
  { id: "automations", label: "Automations" },
];

/**
 * Activity's second sidebar: the feed. Needs-you rows (approvals answerable inline) come
 * first, then mentions, CI and pull-request events and automation results, newest first.
 */
export function ActivitySidebar() {
  return (
    <ViewSidebar title="Activity" toolbar={<FeedTabs />}>
      <FeedList />
    </ViewSidebar>
  );
}

function FeedTabs() {
  const { tab, setTab } = useActivityState();
  const count = useNeedsYouCount();
  return (
    <div role="tablist" aria-label="Activity filter" className="flex shrink-0 px-2.5 pb-2">
      {tabs.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          onClick={() => setTab(entry.id)}
          className={cn(
            "h-[26px] rounded-[7px] px-2 text-[12px] font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--dur-1) hover:bg-sidebar-accent hover:text-foreground",
            tab === entry.id &&
              "bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)] text-foreground hover:bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)]",
          )}
        >
          {entry.label}
          {entry.id === "needs" && count > 0 && (
            <span className="ml-[5px] text-subtle-foreground tabular-nums">{count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

type Other = { at: number; node: ReactNode };
const day = 86_400_000;

function FeedList() {
  const { tab, project } = useActivityState();
  const needs = useNeedsYou();
  const feed = useFeed();
  const runs = useProjectRuns(project);
  const now = useNow();
  const others = useMemo(() => {
    const events = feed.events.filter(
      (event) =>
        (event.kind !== "escalation" || event.resolved) &&
        inProject(project, event.project) &&
        (tab === "all" || (tab === "mentions" && event.kind === "mention")),
    );
    const recentRuns =
      tab === "automations"
        ? runs
        : tab === "all"
          ? runs.filter((run) => now - run.startedAt < day)
          : [];
    const items: Other[] = [
      ...events.map((event) => ({ at: event.at, node: eventRow(event, feed.read) })),
      ...recentRuns.map((run) => ({
        at: run.startedAt,
        node: <RunRow key={run.id} run={run} read={feed.read.has(run.id)} />,
      })),
    ];
    return items.toSorted((a, b) => b.at - a.at).map((item) => item.node);
  }, [feed, runs, project, tab, now]);
  const showNeeds = tab === "all" || tab === "needs";
  const empty =
    (!showNeeds || (!needs.threadIds.length && !needs.escalations.length)) && !others.length;
  if (empty)
    return (
      <EmptyState
        icon={BellIcon}
        title="Nothing here"
        description="Mentions and automation results will show up as they happen."
        className="h-auto pt-16"
      />
    );
  return (
    <ul aria-label="Activity" className="flex flex-col gap-px">
      {showNeeds && (
        <>
          {needs.threadIds.map((id) => (
            <ThreadNeedsRows key={id} threadId={id} />
          ))}
          {needs.escalations.map((event) => eventRow(event, feed.read))}
        </>
      )}
      {others}
    </ul>
  );
}

const eventRow = (event: FeedEvent, read: ReadonlySet<string>) => (
  <EventRow key={event.id} event={event} read={read.has(event.id)} />
);

/** Runs whose automation belongs to the filtered project (all runs when unfiltered). */
function useProjectRuns(project: string | undefined): AutomationRun[] {
  const runs = useAutomationRuns().data;
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
