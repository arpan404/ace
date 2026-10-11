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
  const { project, item, tab, focused, focusCard, selectItem } = useActivityState();
  const { items, loaded } = useFeedItems();
  const count = useNeedsYouCount({ project });
  const needs = useNeedsYou();
  const selected =
    item ??
    focused ??
    (tab === "mentions" || tab === "runs" || (tab === "all" && count === 0)
      ? items[0]?.key
      : needs.entries[0]
        ? `thread:${needs.entries[0].threadId}`
        : undefined);
  const move = (step: number) => {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-activity-key]")];
    const at = rows.findIndex((row) => row.dataset.activityKey === (focused ?? item));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
    const key = next?.dataset.activityKey;
    if (!key) return;
    if (item) selectItem(key);
    else focusCard(key);
    next.scrollIntoView?.({ block: "nearest" });
  };
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
