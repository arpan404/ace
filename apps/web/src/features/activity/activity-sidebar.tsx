import { useSidebarLoaded } from "@ace/client-react";
import { ChecksIcon } from "@phosphor-icons/react";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { useNow } from "@/lib/time.ts";
import { ArrivalScope } from "@/lib/arrival.tsx";
import { useActivityState, type ActivityTab } from "./activity-state.tsx";
import { EventItemRow, RunItemRow } from "./feed-item-rows.tsx";
import { timeGroup, useFeedItems, type FeedItem } from "./feed-items.ts";
import { ThreadNeedsRows } from "./feed-rows.tsx";
import { useFeedSource } from "./feed-source.ts";
import { useReadMode } from "./read-state.ts";
import { useMarkAllRead } from "./use-mark-all-read.ts";
import { useNeedsYou, useNeedsYouCount } from "./use-needs-you.ts";

const tabs: { id: ActivityTab; label: string; empty: string }[] = [
  { id: "all", label: "All", empty: "No activity yet" },
  { id: "needs", label: "Needs you", empty: "Nothing waiting on you" },
  { id: "mentions", label: "Mentions", empty: "No mentions" },
  { id: "runs", label: "Runs", empty: "No automation runs" },
];

/**
 * Activity's list in the sidebar: the feed. What needs you comes first, oldest first (the
 * approvals answerable inline), then mentions, CI and pull-request events and automation runs,
 * newest first under Today, Yesterday, This week and Older.
 */
export function ActivitySidebar() {
  const id = useId();
  return (
    <ViewSidebar title="Activity" actions={<MarkAllRead />} toolbar={<FeedTabs id={id} />}>
      <FeedList id={id} />
    </ViewSidebar>
  );
}

const tabId = (id: string, tab: ActivityTab) => `${id}-tab-${tab}`;

/** The filter tabs: one Tab stop, ←/→/Home/End move between them. */
function FeedTabs(props: { id: string }) {
  const { tab, setTab, project } = useActivityState();
  const count = useNeedsYouCount({ project });
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((entry) => entry.id === tab);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined;
    const target = next === undefined ? undefined : tabs[next];
    if (!target) return;
    event.preventDefault();
    setTab(target.id);
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(props.id, target.id))}`)?.focus();
  };
  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Activity filter"
      onKeyDown={onKeyDown}
      className="flex shrink-0 gap-0.5 px-2.5 pb-2"
    >
      {tabs.map((entry) => (
        <button
          key={entry.id}
          id={tabId(props.id, entry.id)}
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          aria-controls={`${props.id}-panel`}
          tabIndex={tab === entry.id ? 0 : -1}
          onClick={() => setTab(entry.id)}
          className={cn(
            "h-[26px] rounded-sm px-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-(--dur-1) focus-ring hover:bg-sidebar-accent hover:text-foreground",
            tab === entry.id && "bg-foreground/10 text-foreground hover:bg-foreground/10",
          )}
        >
          {entry.label}
          {entry.id === "needs" && count > 0 && (
            <span className="ml-1 text-muted-foreground tabular-nums">{count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Mark all read, for this tab and project, with Undo. */
function MarkAllRead() {
  const { unread, markAll } = useMarkAllRead();
  return (
    <IconButton icon={ChecksIcon} label="Mark all read" disabled={!unread} onClick={markAll} />
  );
}

/** The feed's rows; one Tab stop: ↑/↓, J/K, Home and End move, Enter opens, E/U mark. */
function FeedList(props: { id: string }) {
  const { tab } = useActivityState();
  const needs = useNeedsYou();
  const { items, loaded } = useFeedItems();
  const sidebarLoaded = useSidebarLoaded();
  const source = useFeedSource();
  const now = useNow();
  const keys = useViewListKeys<HTMLUListElement>();
  const readMode = useReadMode();
  const panelId = `${props.id}-panel`;
  const panel = { id: panelId, role: "tabpanel", "aria-labelledby": tabId(props.id, tab) };
  // Esc from a card or an item's page comes back to the list, on the row it left.
  useHotkey("escape", () => {
    const root = document.getElementById(panelId);
    if (!root || root.contains(document.activeElement)) return;
    (
      root.querySelector<HTMLElement>("[data-view-row][aria-current=page]") ??
      root.querySelector<HTMLElement>("[data-view-row][tabindex='0']")
    )?.focus();
  });
  // Never say "nothing here" before the threads and the runs have arrived.
  if (!sidebarLoaded || !loaded)
    return (
      <div {...panel}>
        <ListSkeleton label="activity" shape="tile" rows={4} />
      </div>
    );
  const showNeeds = tab === "all" || tab === "needs";
  const empty = (!showNeeds || !needs.entries.length) && !items.length;
  const label = tabs.find((entry) => entry.id === tab)?.empty ?? "Nothing here";
  if (empty)
    return (
      <div {...panel}>
        <EmptyState variant="inline" title={label} />
      </div>
    );
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return keys.onKeyDown(event);
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-view-row]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if ((event.key === "j" || event.key === "k") && at !== -1) {
      event.preventDefault();
      const target =
        rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "j" ? 1 : -1)))];
      target?.focus();
      target?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    const readId = (document.activeElement as HTMLElement | null)?.dataset.readId;
    if ((event.key === "e" || event.key === "u") && readId) {
      event.preventDefault();
      if (event.key === "e") source.markRead([readId]);
      else source.markUnread([readId]);
      return;
    }
    keys.onKeyDown(event);
  };
  return (
    <div {...panel}>
      {readMode === "refused" && (
        <p className="px-[11px] pt-1 pb-2 text-sm text-muted-foreground">
          This device can't change read marks on the daemon, so they last only until you leave.
        </p>
      )}
      <ul {...keys} onKeyDown={onKeyDown} aria-label="Activity" className="flex flex-col gap-px">
        <ArrivalScope>
          {showNeeds &&
            needs.entries.map((entry) => (
              <ThreadNeedsRows key={entry.threadId} threadId={entry.threadId} />
            ))}
          {grouped(items, now)}
        </ArrivalScope>
      </ul>
    </div>
  );
}

/** Rows newest first under their day headings. */
function grouped(items: readonly FeedItem[], now: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let group: string | undefined;
  for (const item of items) {
    const heading = timeGroup(item.at, now);
    if (heading !== group) {
      group = heading;
      nodes.push(
        <li key={`group:${heading}`} className="px-[11px] pt-3 pb-1.5 first:pt-1">
          <h3 className="text-sm font-medium text-muted-foreground">{heading}</h3>
        </li>,
      );
    }
    nodes.push(
      item.kind === "event" ? (
        <EventItemRow key={item.key} event={item.event} read={item.read} />
      ) : (
        <RunItemRow key={item.key} run={item.run} read={item.read} />
      ),
    );
  }
  return nodes;
}
