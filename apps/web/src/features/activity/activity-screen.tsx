import { needYouPhrase } from "@ace/ui-core/counts";
import { useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen, ViewListPage } from "@/features/shell/index.ts";
import { useProjectName } from "@/lib/projects.ts";
import { ActivityActions, ActivityMenu } from "./activity-header.tsx";
import { useActivityState } from "./activity-state.tsx";
import { useFeedItems } from "./feed-items.ts";
import { ItemDetail } from "./item-detail.tsx";
import { NeedsYouPage } from "./needs-you-page.tsx";
import { NotificationPreferencesDialog } from "./notification-preferences.tsx";
import { PickedBar } from "./picked-bar.tsx";
import { useNeedsYouCount } from "./use-needs-you.ts";

/**
 * Activity: an inbox. The main column shows the item chosen in the sidebar on its own
 * (`?item=`), or, with none chosen, what needs you as answerable cards.
 */
export function ActivityScreen() {
  const { project, item, tab } = useActivityState();
  const { items, loaded } = useFeedItems();
  const count = useNeedsYouCount({ project });
  const selected =
    item ??
    (tab === "mentions" || tab === "runs" || (tab === "all" && count === 0)
      ? items[0]?.key
      : undefined);
  const projectName = useProjectName();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const subtitle = [count ? needYouPhrase(count) : undefined, project && projectName(project)]
    .filter(Boolean)
    .join(" · ");
  const screen = (
    <Screen
      title="Activity"
      subtitle={subtitle || undefined}
      menu={<ActivityMenu onNotificationSettings={() => setPrefsOpen(true)} />}
      actions={<ActivityActions />}
    >
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
      <NotificationPreferencesDialog open={prefsOpen} onOpenChange={setPrefsOpen} />
    </Screen>
  );
  // A narrow window shows the feed as the page until an item is open; a wide one has it beside.
  return item ? screen : <ViewListPage title="Activity" fallback={screen} />;
}
