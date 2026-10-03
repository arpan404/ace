import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ActivityActions, ActivityMenu } from "@/features/activity/activity-header.tsx";
import { NeedsYouPage } from "@/features/activity/needs-you-page.tsx";
import { NotificationPreferencesDialog } from "@/features/activity/notification-preferences.tsx";
import { useNeedsYouCount } from "@/features/activity/use-needs-you.ts";
import { Screen } from "@/features/shell/screen.tsx";

export const Route = createFileRoute("/activity/")({ component: Activity });

function Activity() {
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
