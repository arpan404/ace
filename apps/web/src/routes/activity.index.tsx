import { createFileRoute } from "@tanstack/react-router";
import { NeedsYouPage } from "@/features/activity/needs-you-page.tsx";
import { Screen } from "@/features/shell/screen.tsx";
import { useNeedsYouThreadIds } from "@/features/shell/use-threads.ts";

export const Route = createFileRoute("/activity/")({ component: Activity });

function Activity() {
  const count = useNeedsYouThreadIds().length;
  return (
    <Screen title="Activity" subtitle={count ? `${count} need you` : undefined}>
      <NeedsYouPage />
    </Screen>
  );
}
