import { useState } from "react";
import { Screen } from "@/features/shell/index.ts";
import { ActivityActions, ActivityMenu } from "./activity-header.tsx";
import { NeedsYouPage } from "./needs-you-page.tsx";
import { NotificationPreferencesDialog } from "./notification-preferences.tsx";
import { useNeedsYouCount } from "./use-needs-you.ts";

/** Activity: what needs you, with the feed's filters and notification preferences. */
export function ActivityScreen() {
  const count = useNeedsYouCount();
  const [prefsOpen, setPrefsOpen] = useState(false);
  return (
    <Screen
      title="Activity"
      subtitle={count ? `${count} need you` : undefined}
      menu={<ActivityMenu onNotificationSettings={() => setPrefsOpen(true)} />}
      actions={<ActivityActions />}
    >
      <NeedsYouPage />
      <NotificationPreferencesDialog open={prefsOpen} onOpenChange={setPrefsOpen} />
    </Screen>
  );
}
