import { needYouPhrase } from "@ace/ui-core/counts";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen, ViewListPage } from "@/features/shell/index.ts";
import { useProjectName } from "@/lib/projects.ts";
import { ActivityActions, ActivityMenu } from "./activity-header.tsx";
import { useActivityState } from "./activity-state.tsx";
import { ItemDetail } from "./item-detail.tsx";
import { NeedsYouPage } from "./needs-you-page.tsx";
import { PickedBar } from "./picked-bar.tsx";
import { useNeedsYouCount } from "./use-needs-you.ts";

/**
 * Activity: an inbox. The main column shows the item chosen in the sidebar on its own
 * (`?item=`), or, with none chosen, what needs you as answerable cards.
 */
export function ActivityScreen() {
  const { project, item, tab } = useActivityState();
  const count = useNeedsYouCount({ project });
  const projectName = useProjectName();
  const subtitle = [count ? needYouPhrase(count) : undefined, project && projectName(project)]
    .filter(Boolean)
    .join(" · ");
  const screen = (
    <Screen
      title="Activity"
      subtitle={subtitle || undefined}
      menu={<ActivityMenu />}
      actions={<ActivityActions />}
    >
      {item ? (
        <ItemDetail key={item} itemKey={item} />
      ) : tab === "all" || tab === "needs" ? (
        <NeedsYouPage />
      ) : (
        <EmptyState title="Select an item to see it here" />
      )}
      <PickedBar />
    </Screen>
  );
  // A narrow window shows the feed as the page until an item is open; a wide one has it beside.
  return item ? screen : <ViewListPage title="Activity" fallback={screen} />;
}
