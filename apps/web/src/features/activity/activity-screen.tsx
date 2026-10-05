import { useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useProjectName } from "@/lib/projects.ts";
import { ActivityActions, ActivityMenu } from "./activity-header.tsx";
import { useActivityState } from "./activity-state.tsx";
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
  const count = useNeedsYouCount({ project });
  const projectName = useProjectName();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const subtitle = [count ? `${count} need you` : undefined, project && projectName(project)]
    .filter(Boolean)
    .join(" · ");
  return (
    <Screen
      title="Activity"
      subtitle={subtitle || undefined}
      menu={<ActivityMenu onNotificationSettings={() => setPrefsOpen(true)} />}
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
      <NotificationPreferencesDialog open={prefsOpen} onOpenChange={setPrefsOpen} />
    </Screen>
  );
}
