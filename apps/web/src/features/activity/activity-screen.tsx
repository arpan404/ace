import { useSidebarLoaded } from "@ace/client-react";
import { useEffect, useRef } from "react";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen, ViewListPage } from "@/features/shell/index.ts";
import { ActivityActions, ActivityMenu } from "./activity-header.tsx";
import { useActivityState } from "./activity-state.tsx";
import { useFeedItems } from "./feed-items.ts";
import { ItemDetail } from "./item-detail.tsx";
import { NeedsYouPage } from "./needs-you-page.tsx";
import { PickedBar } from "./picked-bar.tsx";
import { useNeedsYou, useNeedsYouCount } from "./use-needs-you.ts";

/**
 * Activity: an inbox. The main column shows the item chosen in the sidebar on its own
 * (`?item=`), or the first request that needs an answer.
 */
export function ActivityScreen() {
  const { project, item, tab, focused, automaticFocus, focusCard, selectItem } = useActivityState();
  const { items, loaded } = useFeedItems();
  const count = useNeedsYouCount({ project });
  const needs = useNeedsYou();
  const sidebarLoaded = useSidebarLoaded();
  const showNeeds = tab === "all" || tab === "needs";
  const focusedThread = focused?.startsWith("thread:")
    ? focused.slice(7)
    : focused?.startsWith("interaction:")
      ? focused.split(":")[1]
      : undefined;
  const eligible = focusedThread
    ? showNeeds && needs.threadIds.includes(focusedThread)
    : items.some((entry) => entry.key === focused);
  // Explicit links retain their gone/unavailable states. Automatic and keyboard selections
  // follow the current inbox after a release, snooze, archive or filter change.
  useEffect(() => {
    if (!item && focused && !eligible && (focusedThread ? sidebarLoaded : loaded))
      focusCard((current) => (current === focused ? undefined : current));
  }, [item, focused, eligible, focusedThread, sidebarLoaded, loaded, focusCard]);
  const focusAfterMove = useRef<string>(undefined);
  const firstThread = needs.entries[0]?.threadId;
  const firstRequest =
    firstThread && focused?.startsWith(`interaction:${firstThread}:`)
      ? focused
      : firstThread
        ? `thread:${firstThread}`
        : undefined;
  const selected =
    item ??
    (!automaticFocus && eligible ? focused : undefined) ??
    (tab === "mentions" || tab === "runs" || (tab === "all" && count === 0)
      ? items[0]?.key
      : firstRequest);
  const move = (step: number) => {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-activity-key]")];
    const at = rows.findIndex((row) => row.dataset.activityKey === (focused ?? item));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
    const key = next?.dataset.activityKey;
    if (!key) return;
    focusAfterMove.current = key;
    if (item) selectItem(key);
    else focusCard(key);
    next.scrollIntoView?.({ block: "nearest" });
  };
  // A thread read may arrive after selection. Transfer keyboard focus when its detail mounts.
  useEffect(() => {
    const target = focusAfterMove.current;
    if (
      !target ||
      (target !== selected &&
        !(target.startsWith("thread:") && selected?.startsWith(`interaction:${target.slice(7)}:`)))
    )
      return;
    const root = document.getElementById("main");
    if (!root) return;
    const focus = () => {
      const detail = root.querySelector<HTMLElement>("article[tabindex='-1'], [data-view-row]");
      if (!detail) return;
      detail.focus({ preventScroll: true });
      detail.scrollIntoView?.({ block: "nearest" });
      focusAfterMove.current = undefined;
      observer.disconnect();
    };
    const observer = new MutationObserver(focus);
    observer.observe(root, { childList: true, subtree: true });
    focus();
    return () => observer.disconnect();
  }, [selected]);
  const fromDetail = {
    when: (event: KeyboardEvent) =>
      !(event.target instanceof Element) || !event.target.closest("[data-activity-key]"),
  };
  useHotkey(keymap["activity.next"].keys, () => move(1), { ...fromDetail, id: "activity.next" });
  useHotkey(keymap["activity.prev"].keys, () => move(-1), { ...fromDetail, id: "activity.prev" });
  const screen = (
    <Screen title="Activity" menu={<ActivityMenu />} actions={<ActivityActions />}>
      {selected ? (
        <ItemDetail key={selected} itemKey={selected} />
      ) : tab === "all" || tab === "needs" ? (
        <NeedsYouPage />
      ) : (
        <EmptyState
          title={
            loaded
              ? tab === "mentions"
                ? "No mentions"
                : "No automation runs"
              : "Loading activity"
          }
        />
      )}
      <PickedBar />
    </Screen>
  );
  // A narrow window shows the feed as the page until an item is open; a wide one has it beside.
  return item ? screen : <ViewListPage title="Activity" fallback={screen} />;
}
