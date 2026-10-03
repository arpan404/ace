import { BellIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ViewSidebar } from "@/features/shell/view-frame.tsx";

/**
 * Activity's second sidebar. TODO(activity slice): the feed (mentions, CI, PR events,
 * automation results) with All / Needs you / Mentions / Automations filters.
 */
export function ActivitySidebar() {
  return (
    <ViewSidebar title="Activity">
      <EmptyState
        icon={BellIcon}
        title="Nothing here"
        description="Mentions and automation results will show up as they happen."
      />
    </ViewSidebar>
  );
}
